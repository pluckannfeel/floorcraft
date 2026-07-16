import { useCallback, useEffect, useRef } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import type Konva from "konva";
import { apiClient } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useIsObjectsMutating, useObjectPersistence, useObjects } from "../hooks/useObjects";
import { useCanvasStore } from "../state/canvasStore";
import { useCanvasShortcuts } from "../hooks/useCanvasShortcuts";
import { CanvasStage } from "./CanvasStage";
import { computeLineBoundingBox, curveStyleForType } from "./LineTool";
import { PropertyPanel } from "./PropertyPanel";
import type { ShapeGeometry } from "./ShapeTool";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import type {
  CanvasObject,
  CatalogType,
  FloorPlan,
  LineType,
  Point,
  ShapeType,
} from "./types";
import { isLocalId } from "./types";

/** True when a floor-plan fetch failed because the backend answered 404 —
 * per U2's per-user queryset scoping, a nonexistent id and someone else's
 * floor plan are deliberately indistinguishable (R14). */
function isNotFoundError(error: unknown): boolean {
  return (error as AxiosError | null | undefined)?.response?.status === 404;
}

/**
 * Canvas editor for one floor plan, mounted at "/floor-plans/:floorPlanId"
 * behind `RequireAuth` (U5). Fetches the route's `FloorPlan` and its
 * Objects, then composes the Konva stage and the catalog sidebar. A
 * nonexistent or foreign-owned id (the backend 404s both identically, R14),
 * or a malformed one, renders a not-found state linking back to the
 * dashboard instead of the editor.
 */
export function CanvasEditorPage() {
  const { logout } = useAuth();
  const stageRef = useRef<Konva.Stage | null>(null);

  // U5: the editor is route-driven. A malformed (`NaN` after `Number(...)`)
  // or non-positive param can never match a backend row, so it's treated
  // exactly like a 404 below — without ever firing a request for it (both
  // queries are `enabled`-gated on validity).
  const { floorPlanId: floorPlanIdParam } = useParams<{
    floorPlanId: string;
  }>();
  const floorPlanId = Number(floorPlanIdParam);
  const isValidFloorPlanId = Number.isInteger(floorPlanId) && floorPlanId > 0;

  const floorPlanQuery = useQuery({
    queryKey: ["floorPlan", floorPlanId],
    queryFn: async () => {
      const { data } = await apiClient.get<FloorPlan>(
        `/floor-plans/${floorPlanId}/`,
      );
      return data;
    },
    enabled: isValidFloorPlanId,
    // A 404 is a definitive answer (not yours / doesn't exist, R14), not a
    // transient failure — retrying it would just loop before the not-found
    // state below renders. Other failures keep a small retry budget.
    retry: (failureCount, error) =>
      !isNotFoundError(error) && failureCount < 2,
  });

  const objectsQuery = useObjects(floorPlanId);
  // U13: the single persistence handle every create/update/delete below
  // dispatches through — also the thing that gets registered as
  // `canvasStore.ts`'s module-level dispatcher for undo/redo (see
  // `useObjects.ts`'s `useObjectPersistence` doc comment).
  const persistence = useObjectPersistence(floorPlanId);
  // Keyed to the CURRENT route's floorPlanId (institutional learning:
  // tanstack-query-cross-mutation-resync-flicker) — navigating between two
  // plans must not let one plan's settling mutation gate (or clobber) the
  // other plan's resync.
  const isMutating = useIsObjectsMutating(floorPlanId);

  const items = useCanvasStore((state) => state.items);
  const selectedItemId = useCanvasStore((state) => state.selectedItemId);
  const activeTool = useCanvasStore((state) => state.activeTool);
  const zoom = useCanvasStore((state) => state.zoom);
  const stagePosition = useCanvasStore((state) => state.stagePosition);
  const setItems = useCanvasStore((state) => state.setItems);
  const createItemLocal = useCanvasStore((state) => state.createItemLocal);
  const selectItem = useCanvasStore((state) => state.selectItem);
  const updateItemGeometry = useCanvasStore(
    (state) => state.updateItemGeometry,
  );
  const updateLinePoints = useCanvasStore((state) => state.updateLinePoints);
  const deleteItem = useCanvasStore((state) => state.deleteItem);
  const reorderZIndex = useCanvasStore((state) => state.reorderZIndex);
  const setActiveTool = useCanvasStore((state) => state.setActiveTool);
  const setZoomAndPosition = useCanvasStore(
    (state) => state.setZoomAndPosition,
  );
  const setStagePosition = useCanvasStore((state) => state.setStagePosition);

  // U13: every wrapped handler below follows the same shape — capture the
  // item's pre-change snapshot (for the mutation's onError rollback),
  // apply the LOCAL store action (unchanged from U7-U18, still instant per
  // R16), then dispatch the matching persistence call, skipped for an item
  // that's still `local-`-id-only (its create POST hasn't resolved yet, so
  // there's no backend row yet to PATCH/DELETE against — see `isLocalId`).

  // activate keyboard shortcuts for undo/redo (R15) — see `useCanvasShortcuts.ts`
  useCanvasShortcuts();

  const handleDeleteSelected = useCallback(() => {
    if (selectedItemId == null) return;
    const previous = items.find((item) => item.id === selectedItemId);
    deleteItem(selectedItemId);
    if (previous && !isLocalId(selectedItemId)) {
      persistence.deleteObject(selectedItemId, previous);
    }
  }, [selectedItemId, items, deleteItem, persistence]);

  const handleGeometryChange = useCallback(
    (
      id: CanvasObject["id"],
      patch: Partial<
        Pick<CanvasObject, "x" | "y" | "width" | "height" | "rotation">
      >,
    ) => {
      const previous = items.find((item) => item.id === id);
      updateItemGeometry(id, patch);
      if (previous && !isLocalId(id)) {
        persistence.updateObject(id, patch, previous);
      }
    },
    [items, updateItemGeometry, persistence],
  );

  const handleLinePointDragEnd = useCallback(
    (id: CanvasObject["id"], pointIndex: number, point: Point) => {
      const previous = items.find((item) => item.id === id);
      updateLinePoints(id, pointIndex, point);
      if (previous && !isLocalId(id)) {
        const updated = useCanvasStore
          .getState()
          .items.find((item) => item.id === id);
        if (updated) {
          persistence.updateObject(
            id,
            { properties: updated.properties },
            previous,
          );
        }
      }
    },
    [items, updateLinePoints, persistence],
  );

  const handleReorderZIndex = useCallback(
    (id: CanvasObject["id"], direction: "front" | "back") => {
      const previous = items.find((item) => item.id === id);
      reorderZIndex(id, direction);
      if (previous && !isLocalId(id)) {
        const updated = useCanvasStore
          .getState()
          .items.find((item) => item.id === id);
        if (updated) {
          persistence.updateObject(id, { z_index: updated.z_index }, previous);
        }
      }
    },
    [items, reorderZIndex, persistence],
  );

  // U10/U13: Property Panel edits are excluded from undo (R15) but DO still
  // persist ("Writes go through updateItemProperties ... and the
  // persistence hook (U13)", U10's Approach). Unlike the handlers above,
  // `PropertyPanel` itself already applies the local `updateItemProperties`
  // commit (see that component's doc comment) and hands this callback the
  // already-captured `previous` snapshot — this handler's only job is
  // dispatching the matching persistence call.
  const handlePropertiesPersist = useCallback(
    (
      id: CanvasObject["id"],
      patch: { name?: string; properties?: Record<string, unknown> },
      previous: CanvasObject,
    ) => {
      if (!isLocalId(id)) {
        persistence.updateObject(id, patch, previous);
      }
    },
    [persistence],
  );

  // U5: the zustand canvasStore — including its zundo undo/redo history —
  // is module-global, while this editor renders one floor plan at a time.
  // `items` themselves are replaced by the resync effect below once the new
  // plan's objects load (untracked via temporal.pause/resume), but zundo's
  // past/future stacks would otherwise survive a plan switch, letting plan
  // A's undo history apply onto plan B's canvas. Clearing keyed on the
  // route's floorPlanId guarantees each plan starts with a fresh history.
  useEffect(() => {
    useCanvasStore.temporal.getState().clear();
  }, [floorPlanId]);

  // Seed the store from the fetched Objects once they load. Later fetches
  // (e.g. a refetch) also resync — U13 layers real mutations on top without
  // changing this initial-load behavior.
  //
  // Gated on `!isMutating` (code-review finding, fixed): every mutation's
  // `onSettled` invalidates this same query key, so one mutation settling
  // can trigger a refetch whose data is stale for a DIFFERENT, still-in-
  // flight mutation's item — resyncing then would transiently overwrite
  // that item's optimistic change. Deferring until nothing is mutating
  // means the resync that does land always reflects every optimistic
  // change already having a settled (success or rolled-back) outcome.
  useEffect(() => {
    if (objectsQuery.data && !isMutating) {
      setItems(objectsQuery.data);
    }
  }, [objectsQuery.data, isMutating, setItems]);

  const getStage = useCallback(() => stageRef.current, []);

  // Shared by handleDrop/handleCreateShape/handleCreateLine below: every
  // newly-created Object needs a locally-created client-side id (until U13's
  // persistence swaps it for the server-assigned one), a top-of-stack
  // z_index, and the same fixed set of defaulted fields — only the type,
  // geometry, and properties actually differ per creation path.
  const buildLocalObject = useCallback(
    (
      floorPlanId: number,
      type: CanvasObject["type"],
      geometry: { x: number; y: number; width: number; height: number },
      properties: CanvasObject["properties"] = {},
    ): CanvasObject => {
      const maxZIndex = items.reduce(
        (max, item) => Math.max(max, item.z_index),
        -1,
      );
      return {
        id: `local-${crypto.randomUUID()}`,
        floor_plan: floorPlanId,
        type,
        name: "",
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        rotation: 0,
        z_index: maxZIndex + 1,
        properties,
      };
    },
    [items],
  );

  const handleDrop = useCallback(
    (type: CatalogType, point: Point) => {
      const floorPlan = floorPlanQuery.data;
      if (!floorPlan) return;

      const newItem = buildLocalObject(floorPlan.id, type, {
        x: point.x,
        y: point.y,
        width: 40,
        height: 40,
      });
      createItemLocal(newItem);
      persistence.createObject(newItem);
    },
    [floorPlanQuery.data, buildLocalObject, createItemLocal, persistence],
  );

  // U15: commits a click-drag-sized Shape. Resets `activeTool` back to
  // 'select' per the plan, so drawing one Shape doesn't leave the tool
  // "stuck" active.
  const handleCreateShape = useCallback(
    (type: ShapeType, geometry: ShapeGeometry) => {
      const floorPlan = floorPlanQuery.data;
      if (!floorPlan) return;

      const newItem = buildLocalObject(floorPlan.id, type, geometry);
      createItemLocal(newItem);
      persistence.createObject(newItem);
      setActiveTool("select");
    },
    [floorPlanQuery.data, buildLocalObject, createItemLocal, setActiveTool, persistence],
  );

  // U16: commits a finished (>= 2 points) click-per-point Line.
  // `x`/`y`/`width`/`height` are the points' bounding box — descriptive
  // metadata only (per LineTool.tsx's `computeLineBoundingBox` doc), since
  // `properties.points` remains the actual rendering/editing source of
  // truth. `curve_style` is included in `properties` for every Line type
  // (not just curved ones) even though the backend serializer only requires
  // it for `line_curved`/`line_s_curve` — keeping it uniformly present
  // avoids a "some Lines have curve_style, some don't" special case.
  const handleCreateLine = useCallback(
    (type: LineType, points: Point[]) => {
      const floorPlan = floorPlanQuery.data;
      if (!floorPlan) return;

      const bbox = computeLineBoundingBox(points);
      const newItem = buildLocalObject(floorPlan.id, type, bbox, {
        points,
        curve_style: curveStyleForType(type),
      });
      createItemLocal(newItem);
      persistence.createObject(newItem);
      setActiveTool("select");
    },
    [floorPlanQuery.data, buildLocalObject, createItemLocal, setActiveTool, persistence],
  );

  // U5/R14: a malformed route param or a 404 (nonexistent, or someone
  // else's plan — the backend deliberately doesn't distinguish) renders a
  // not-found state with a way back, rather than crashing or retry-looping.
  // Checked before the loading branch: a foreign plan's objects query can
  // still be in flight while the floor-plan 404 is already definitive.
  if (!isValidFloorPlanId || isNotFoundError(floorPlanQuery.error)) {
    return (
      <div role="alert">
        <p>Floor plan not found.</p>
        <Link to="/floor-plans">Back to dashboard</Link>
      </div>
    );
  }

  if (floorPlanQuery.isLoading || objectsQuery.isLoading) {
    return <div role="status">Loading floor plan…</div>;
  }

  if (floorPlanQuery.isError || !floorPlanQuery.data) {
    return (
      <div role="alert">
        <p>Unable to load the floor plan.</p>
        <Link to="/floor-plans">Back to dashboard</Link>
      </div>
    );
  }

  const floorPlan = floorPlanQuery.data;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 16px",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <h1 style={{ fontSize: 16, margin: 0 }}>
          {floorPlan.name || "Floor plan"}
        </h1>
        <button type="button" onClick={() => logout()}>
          Log out
        </button>
      </header>

      <Toolbar
        getStage={getStage}
        selectedItemId={selectedItemId}
        onReorderZIndex={handleReorderZIndex}
      />

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <Sidebar
          getStage={getStage}
          gridSize={floorPlan.grid_size}
          canvasWidth={floorPlan.canvas_width}
          canvasHeight={floorPlan.canvas_height}
          onDrop={handleDrop}
        />
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          <CanvasStage
            ref={stageRef}
            width={floorPlan.canvas_width}
            height={floorPlan.canvas_height}
            gridSize={floorPlan.grid_size}
            objects={items}
            selectedItemId={selectedItemId}
            onSelectObject={selectItem}
            onGeometryChange={handleGeometryChange}
            onDeleteSelected={handleDeleteSelected}
            activeTool={activeTool}
            onCreateShape={handleCreateShape}
            onCreateLine={handleCreateLine}
            onLinePointDragEnd={handleLinePointDragEnd}
            zoom={zoom}
            stagePosition={stagePosition}
            onZoomChange={setZoomAndPosition}
            onPanEnd={setStagePosition}
          />
        </div>
        <PropertyPanel onPersist={handlePropertiesPersist} />
      </div>
    </div>
  );
}
