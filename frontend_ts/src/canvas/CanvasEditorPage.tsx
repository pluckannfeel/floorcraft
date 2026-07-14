import { useCallback, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type Konva from 'konva'
import { apiClient } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { useObjects } from '../hooks/useObjects'
import { useCanvasStore } from '../state/canvasStore'
import { CanvasStage } from './CanvasStage'
import { Sidebar } from './Sidebar'
import type { CanvasObject, CatalogType, FloorPlan, Point } from './types'
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
  const setItems = useCanvasStore((state) => state.setItems)
  const createItemLocal = useCanvasStore((state) => state.createItemLocal)
  const selectItem = useCanvasStore((state) => state.selectItem)

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
          />
        </div>
      </div>
    </div>
  )
}
