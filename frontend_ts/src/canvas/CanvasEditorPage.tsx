import { useCallback, useEffect, useRef } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import type Konva from "konva";
import { Save, SaveCheck, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useObjects, useSaveObjects } from "../hooks/useObjects";
import { useCanvasStore } from "../state/canvasStore";
import { useCanvasShortcuts } from "../hooks/useCanvasShortcuts";
import { CanvasStage } from "./CanvasStage";
import { FloorPlanNameEditor } from "./FloorPlanNameEditor";
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
 *
 * Persistence model (explicit save): every canvas edit below is a pure
 * local store mutation — nothing persists per action. The store's `dirty`
 * flag drives the header's "Unsaved changes"/"Saved" indicator, the Save
 * button, and the leave guards; the ONLY write path to the backend is
 * `useSaveObjects` (Save button or Ctrl+S), which PUTs the full items list
 * and re-baselines the store from the canonical response.
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
    retry: (failureCount, error) => !isNotFoundError(error) && failureCount < 2,
  });

  const objectsQuery = useObjects(floorPlanId);
  // The explicit save: PUTs the store's full items list (ids translated
  // through `serverIdMap`) and merges the response's id_map back — items
  // and undo history are deliberately untouched, so undo/redo keep working
  // across saves. See `useObjects.ts`'s `useSaveObjects` doc comment.
  const { mutate: saveObjects, isPending: isSaving } =
    useSaveObjects(floorPlanId);

  const items = useCanvasStore((state) => state.items);
  const selectedItemIds = useCanvasStore((state) => state.selectedItemIds);
  const activeTool = useCanvasStore((state) => state.activeTool);
  const zoom = useCanvasStore((state) => state.zoom);
  const stagePosition = useCanvasStore((state) => state.stagePosition);
  const dirty = useCanvasStore((state) => state.dirty);
  const setItems = useCanvasStore((state) => state.setItems);
  const createItemLocal = useCanvasStore((state) => state.createItemLocal);
  const replaceSelection = useCanvasStore((state) => state.replaceSelection);
  // U4: ctrl+click routing is group-aware — CanvasStage expands the clicked
  // member's group and toggles the whole id set atomically.
  const toggleIdsInSelection = useCanvasStore(
    (state) => state.toggleIdsInSelection,
  );
  const clearSelection = useCanvasStore((state) => state.clearSelection);
  const updateItemGeometry = useCanvasStore(
    (state) => state.updateItemGeometry,
  );
  const updateItemsGeometry = useCanvasStore(
    (state) => state.updateItemsGeometry,
  );
  const updateLinePoints = useCanvasStore((state) => state.updateLinePoints);
  const deleteItems = useCanvasStore((state) => state.deleteItems);
  const reorderZIndexItems = useCanvasStore(
    (state) => state.reorderZIndexItems,
  );
  const setActiveTool = useCanvasStore((state) => state.setActiveTool);
  const setZoomAndPosition = useCanvasStore(
    (state) => state.setZoomAndPosition,
  );
  const setStagePosition = useCanvasStore((state) => state.setStagePosition);

  // Airtight in-flight guard (a render-closure `isSaving` isn't: two rapid
  // Ctrl+S presses can both land before the re-registered listener sees the
  // pending state, firing two overlapping full-replace PUTs). The ref flips
  // synchronously at dispatch, so the second press is a guaranteed no-op.
  const saveInFlightRef = useRef(false);
  const handleSave = useCallback(() => {
    // Commit any in-progress field edit first: the Property Panel commits
    // drafts on blur, so Ctrl+S mid-typing would otherwise save WITHOUT
    // the text on screen (and then show "Saved"). Blur fires the commit
    // synchronously into the store before the dirty check below runs.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    // Read `dirty` off the store directly so the guard is always current —
    // this callback is also Ctrl+S's target (via `useCanvasShortcuts`
    // below), which can fire between renders.
    if (!useCanvasStore.getState().dirty || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    saveObjects(undefined, {
      onSettled: () => {
        saveInFlightRef.current = false;
      },
    });
  }, [saveObjects]);

  // Keyboard shortcuts: undo/redo (R15) plus Ctrl/Cmd+S -> explicit save —
  // see `useCanvasShortcuts.ts`.
  useCanvasShortcuts(handleSave);

  // U1: Delete removes the WHOLE selection in one batched store action —
  // one history entry however many items were selected (the action also
  // drops the deleted ids from the selection itself).
  const handleDeleteSelected = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    deleteItems(selectedItemIds);
  }, [selectedItemIds, deleteItems]);

  // U5: the zustand canvasStore — including its zundo undo/redo history —
  // is module-global, while this editor renders one floor plan at a time.
  // `items` themselves are replaced by the seed effect below once the new
  // plan's objects load (untracked via temporal.pause/resume), but
  // everything else would survive a plan switch: zundo's past/future stacks
  // (plan A's undo history applying onto plan B's canvas), the selection
  // (stale plan-A ids enabling z-order buttons and making Delete push a
  // junk undo entry on plan B), the previous plan's items (rendered as
  // plan B's if B's objects fetch errors before ever reseeding), and the
  // zoom/pan. Reset all of it keyed on the route's floorPlanId. `setItems`
  // also clears `dirty`, so a stale unsaved-changes flag can't leak onto
  // the next plan either.
  const seededForPlanRef = useRef<number | null>(null);
  useEffect(() => {
    const store = useCanvasStore.getState();
    store.setItems([]); // pauses/resumes zundo internally; clears dirty
    store.clearSelection(); // untracked (partialize covers items only)
    store.resetZoom(); // untracked
    useCanvasStore.temporal.getState().clear();
    // Forget which plan was seeded, too: without this, a same-mount
    // A -> B -> A param sequence where B's fetch never resolved would find
    // the ref still equal to A and leave plan A permanently empty (and a
    // save from that state would wipe A's objects server-side).
    seededForPlanRef.current = null;
  }, [floorPlanId]);

  // Seed the store from the fetched Objects ONCE per floor plan (reseeding
  // again on a plan switch, after the reset effect above emptied the
  // store).
  //
  // Strictly once, not on every data change: with explicit save the store
  // is the single source of truth for the whole editing session — a
  // background refetch (e.g. refetch-on-window-focus) must never clobber
  // unsaved local edits, and the post-save `setQueryData` must not trigger
  // a re-baseline either (setItems would reset `serverIdMap` and swap item
  // ids out from under the undo history, breaking undo/redo after a save).
  useEffect(() => {
    if (
      objectsQuery.data &&
      seededForPlanRef.current !== floorPlanId
    ) {
      seededForPlanRef.current = floorPlanId;
      setItems(objectsQuery.data);
    }
  }, [objectsQuery.data, floorPlanId, setItems]);

  // Leave guards: closing/reloading the tab with unsaved changes (or while
  // the save PUT is still in flight) would lose them — surface the
  // browser's native confirmation. (In-app exits — the Home link and Log
  // out — get their own confirm() below, since beforeunload doesn't fire
  // for SPA navigation.)
  useEffect(() => {
    if (!dirty && !isSaving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome ignores preventDefault alone; returnValue must be set for
      // the dialog to appear.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, isSaving]);

  const confirmLeaveWithUnsavedChanges = useCallback(
    () =>
      (!dirty && !isSaving) ||
      window.confirm("You have unsaved changes. Leave anyway?"),
    [dirty, isSaving],
  );

  const getStage = useCallback(() => stageRef.current, []);

  // Shared by handleDrop/handleCreateShape/handleCreateLine below: every
  // newly-created Object gets a client-side `local-` id (kept until the
  // next explicit save round-trips it for a server-assigned one), a
  // top-of-stack z_index, and the same fixed set of defaulted fields — only
  // the type, geometry, and properties actually differ per creation path.
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

      createItemLocal(
        buildLocalObject(floorPlan.id, type, {
          x: point.x,
          y: point.y,
          width: 40,
          height: 40,
        }),
      );
    },
    [floorPlanQuery.data, buildLocalObject, createItemLocal],
  );

  // U15: commits a click-drag-sized Shape. Resets `activeTool` back to
  // 'select' per the plan, so drawing one Shape doesn't leave the tool
  // "stuck" active.
  const handleCreateShape = useCallback(
    (type: ShapeType, geometry: ShapeGeometry) => {
      const floorPlan = floorPlanQuery.data;
      if (!floorPlan) return;

      createItemLocal(buildLocalObject(floorPlan.id, type, geometry));
      setActiveTool("select");
    },
    [floorPlanQuery.data, buildLocalObject, createItemLocal, setActiveTool],
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
      createItemLocal(
        buildLocalObject(floorPlan.id, type, bbox, {
          points,
          curve_style: curveStyleForType(type),
        }),
      );
      setActiveTool("select");
    },
    [floorPlanQuery.data, buildLocalObject, createItemLocal, setActiveTool],
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

  // `objectsQuery.isError` matters as much as the floor-plan errors: without
  // it, a failed INITIAL objects fetch would fall through and render the
  // editor over an empty (plan-switch-reset) store, misrepresenting a
  // populated plan as empty. But only when there's no data at all —
  // `isError` also flips on a failed BACKGROUND refetch (e.g. window-focus
  // with the backend blipping), and replacing the editor then would strand
  // unsaved dirty edits behind an error page with no Save button. With
  // cached data present the editor keeps rendering; the store (already
  // seeded) is the source of truth either way.
  if (
    floorPlanQuery.isError ||
    !floorPlanQuery.data ||
    (objectsQuery.isError && !objectsQuery.data)
  ) {
    return (
      <div role="alert">
        <p>Unable to load the floor plan.</p>
        {/* Guarded like every other in-app exit: if the store somehow
            holds unsaved work (e.g. a floor-plan refetch failed after
            editing began), leaving still asks first. */}
        <Link
          to="/floor-plans"
          onClick={(event) => {
            if (!confirmLeaveWithUnsavedChanges()) event.preventDefault();
          }}
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  const floorPlan = floorPlanQuery.data;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          {/* U6/R13: the name label is inline-editable (click it, or the
              pencil button) — see FloorPlanNameEditor.tsx. */}
          <FloorPlanNameEditor
            floorPlanId={floorPlan.id}
            name={floorPlan.name}
          />
          <span aria-hidden="true" className="h-4 w-px bg-border" />
          {/* Page navigation: "Home" is the floor-plan dashboard ("/" just
              redirects there, so link to it directly). */}
          <nav aria-label="Page navigation">
            <Link
              to="/floor-plans"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              onClick={(event) => {
                if (!confirmLeaveWithUnsavedChanges()) event.preventDefault();
              }}
            >
              Home
            </Link>
          </nav>
          {/* Save button doubling as the save-state indicator: canvas edits
              stay local until the user explicitly saves (Ctrl+S works too),
              so its label is the "you have unsaved changes" signal — Save
              (unsaved) / Saving… (PUT in flight) / Saved (clean). */}
          <Button
            variant={dirty ? "default" : "ghost"}
            size="sm"
            aria-label="Save changes"
            disabled={!dirty || isSaving}
            onClick={handleSave}
          >
            {isSaving ? (
              <>
                <LoaderCircle className="animate-spin" /> Saving…
              </>
            ) : dirty ? (
              <>
                <Save /> Save
              </>
            ) : (
              <>
                <SaveCheck /> Saved
              </>
            )}
          </Button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (confirmLeaveWithUnsavedChanges()) logout();
          }}
        >
          Log out
        </Button>
      </header>

      <Toolbar
        getStage={getStage}
        selectedItemIds={selectedItemIds}
        onReorderZIndex={reorderZIndexItems}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          getStage={getStage}
          gridSize={floorPlan.grid_size}
          canvasWidth={floorPlan.canvas_width}
          canvasHeight={floorPlan.canvas_height}
          onDrop={handleDrop}
        />
        <div className="flex-1 overflow-auto p-4">
          <CanvasStage
            ref={stageRef}
            width={floorPlan.canvas_width}
            height={floorPlan.canvas_height}
            gridSize={floorPlan.grid_size}
            objects={items}
            selectedItemIds={selectedItemIds}
            onReplaceSelection={replaceSelection}
            onToggleIdsInSelection={toggleIdsInSelection}
            onClearSelection={clearSelection}
            onGeometryChange={updateItemGeometry}
            onItemsGeometryChange={updateItemsGeometry}
            onDeleteSelected={handleDeleteSelected}
            activeTool={activeTool}
            onCreateShape={handleCreateShape}
            onCreateLine={handleCreateLine}
            onLinePointDragEnd={updateLinePoints}
            zoom={zoom}
            stagePosition={stagePosition}
            onZoomChange={setZoomAndPosition}
            onPanEnd={setStagePosition}
          />
        </div>
        <PropertyPanel />
      </div>
    </div>
  );
}
