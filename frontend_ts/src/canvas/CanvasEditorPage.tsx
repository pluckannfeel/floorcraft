import { useCallback, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type Konva from 'konva'
import { apiClient } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { useObjects } from '../hooks/useObjects'
import { useCanvasStore } from '../state/canvasStore'
import { CanvasStage } from './CanvasStage'
import { computeLineBoundingBox, curveStyleForType } from './LineTool'
import type { ShapeGeometry } from './ShapeTool'
import { Sidebar } from './Sidebar'
import { Toolbar } from './Toolbar'
import type { CanvasObject, CatalogType, FloorPlan, LineType, Point, ShapeType } from './types'
import { DEFAULT_FLOOR_PLAN_ID } from './types'

/**
 * Top-level canvas editor route (mounted at "/" behind `RequireAuth`,
 * R8/U5). Fetches `FloorPlan` id=1 (the only FloorPlan row — no
 * floor-plan selector per confirmed scope) and its Objects, then composes
 * the Konva stage and the catalog sidebar.
 *
 * Property panel and toolbar (undo/redo, zoom, drawing tools, z-order) are
 * later units (U8-U18) — this unit only needs the shell structure they'll
 * slot into.
 */
export function CanvasEditorPage() {
  const { logout } = useAuth()
  const stageRef = useRef<Konva.Stage | null>(null)

  const floorPlanQuery = useQuery({
    queryKey: ['floorPlan', DEFAULT_FLOOR_PLAN_ID],
    queryFn: async () => {
      const { data } = await apiClient.get<FloorPlan>(`/floor-plans/${DEFAULT_FLOOR_PLAN_ID}/`)
      return data
    },
  })

  const objectsQuery = useObjects(DEFAULT_FLOOR_PLAN_ID)

  const items = useCanvasStore((state) => state.items)
  const selectedItemId = useCanvasStore((state) => state.selectedItemId)
  const activeTool = useCanvasStore((state) => state.activeTool)
  const setItems = useCanvasStore((state) => state.setItems)
  const createItemLocal = useCanvasStore((state) => state.createItemLocal)
  const selectItem = useCanvasStore((state) => state.selectItem)
  const updateItemGeometry = useCanvasStore((state) => state.updateItemGeometry)
  const updateLinePoints = useCanvasStore((state) => state.updateLinePoints)
  const deleteItem = useCanvasStore((state) => state.deleteItem)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)

  const handleDeleteSelected = useCallback(() => {
    if (selectedItemId != null) deleteItem(selectedItemId)
  }, [selectedItemId, deleteItem])

  // Seed the store from the fetched Objects once they load. Later fetches
  // (e.g. a refetch) also resync — U13 layers real mutations on top without
  // changing this initial-load behavior.
  useEffect(() => {
    if (objectsQuery.data) {
      setItems(objectsQuery.data)
    }
  }, [objectsQuery.data, setItems])

  const getStage = useCallback(() => stageRef.current, [])

  const handleDrop = useCallback(
    (type: CatalogType, point: Point) => {
      const floorPlan = floorPlanQuery.data
      if (!floorPlan) return

      const maxZIndex = items.reduce((max, item) => Math.max(max, item.z_index), -1)
      const newItem: CanvasObject = {
        // Locally-created items get a client-side id until U13 wires real
        // persistence (POST) and swaps it for the server-assigned id.
        id: `local-${crypto.randomUUID()}`,
        floor_plan: floorPlan.id,
        type,
        name: '',
        x: point.x,
        y: point.y,
        width: 40,
        height: 40,
        rotation: 0,
        z_index: maxZIndex + 1,
        properties: {},
      }
      createItemLocal(newItem)
    },
    [floorPlanQuery.data, items, createItemLocal],
  )

  // U15: commits a click-drag-sized Shape. Same locally-created-id pattern
  // as `handleDrop` above (U13 later swaps in the server-assigned id) — the
  // only difference is the source of x/y/width/height (drag geometry vs.
  // sidebar's fixed DEFAULT_ITEM_SIZE) and the object `type` (a ShapeType,
  // not a CatalogType). Resets `activeTool` back to `'select'` per the
  // plan, so drawing one Shape doesn't leave the tool "stuck" active.
  const handleCreateShape = useCallback(
    (type: ShapeType, geometry: ShapeGeometry) => {
      const floorPlan = floorPlanQuery.data
      if (!floorPlan) return

      const maxZIndex = items.reduce((max, item) => Math.max(max, item.z_index), -1)
      const newItem: CanvasObject = {
        id: `local-${crypto.randomUUID()}`,
        floor_plan: floorPlan.id,
        type,
        name: '',
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        rotation: 0,
        z_index: maxZIndex + 1,
        properties: {},
      }
      createItemLocal(newItem)
      setActiveTool('select')
    },
    [floorPlanQuery.data, items, createItemLocal, setActiveTool],
  )

  // U16: commits a finished (>= 2 points) click-per-point Line. Same
  // locally-created-id pattern as `handleDrop`/`handleCreateShape` above.
  // `x`/`y`/`width`/`height` are the points' bounding box — descriptive
  // metadata only (per LineTool.tsx's `computeLineBoundingBox` doc), since
  // `properties.points` remains the actual rendering/editing source of
  // truth. `curve_style` is included in `properties` for every Line type
  // (not just curved ones) even though the backend serializer only requires
  // it for `line_curved`/`line_s_curve` — keeping it uniformly present
  // avoids a "some Lines have curve_style, some don't" special case.
  const handleCreateLine = useCallback(
    (type: LineType, points: Point[]) => {
      const floorPlan = floorPlanQuery.data
      if (!floorPlan) return

      const maxZIndex = items.reduce((max, item) => Math.max(max, item.z_index), -1)
      const bbox = computeLineBoundingBox(points)
      const newItem: CanvasObject = {
        id: `local-${crypto.randomUUID()}`,
        floor_plan: floorPlan.id,
        type,
        name: '',
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
        rotation: 0,
        z_index: maxZIndex + 1,
        properties: { points, curve_style: curveStyleForType(type) },
      }
      createItemLocal(newItem)
      setActiveTool('select')
    },
    [floorPlanQuery.data, items, createItemLocal, setActiveTool],
  )

  if (floorPlanQuery.isLoading || objectsQuery.isLoading) {
    return <div role="status">Loading floor plan…</div>
  }

  if (floorPlanQuery.isError || !floorPlanQuery.data) {
    return <div role="alert">Unable to load the floor plan.</div>
  }

  const floorPlan = floorPlanQuery.data

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          borderBottom: '1px solid #e5e7eb',
        }}
      >
        <h1 style={{ fontSize: 16, margin: 0 }}>{floorPlan.name || 'Floor plan'}</h1>
        <button type="button" onClick={() => logout()}>
          Log out
        </button>
      </header>

      <Toolbar />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar
          getStage={getStage}
          gridSize={floorPlan.grid_size}
          canvasWidth={floorPlan.canvas_width}
          canvasHeight={floorPlan.canvas_height}
          onDrop={handleDrop}
        />
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          <CanvasStage
            ref={stageRef}
            width={floorPlan.canvas_width}
            height={floorPlan.canvas_height}
            gridSize={floorPlan.grid_size}
            objects={items}
            selectedItemId={selectedItemId}
            onSelectObject={selectItem}
            onGeometryChange={updateItemGeometry}
            onDeleteSelected={handleDeleteSelected}
            activeTool={activeTool}
            onCreateShape={handleCreateShape}
            onCreateLine={handleCreateLine}
            onLinePointDragEnd={updateLinePoints}
          />
        </div>
      </div>
    </div>
  )
}
