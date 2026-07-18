import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  buildAlignPatches,
  buildDistributePatches,
} from "./alignment";
import type { AlignKind, DistributeAxis } from "./alignment";
import { CanvasStage } from "./CanvasStage";
import type { ContextMenuRequest } from "./CanvasStage";
import {
  buildClipboardPayload,
  getClipboard,
  hasClipboardContent,
  mintClipboardItems,
  resolvePastePoint,
  setClipboard,
} from "./clipboard";
import type { ClipboardPayload } from "./clipboard";
import { ContextMenu, resolveContextMenuAvailability } from "./ContextMenu";
import { clampToBounds, snapToGrid } from "./coordinates";
import type { BoundingBox } from "./coordinates";
import { FloorPlanNameEditor } from "./FloorPlanNameEditor";
import { computeLineBoundingBox, curveStyleForType } from "./LineTool";
import { PropertyPanel } from "./PropertyPanel";
import type { ShapeGeometry } from "./ShapeTool";
import { Sidebar } from "./Sidebar";
import { TextEditOverlay } from "./TextEditOverlay";
import {
  DEFAULT_TEXT_STYLING,
  measureTextBox,
  parseTextProperties,
} from "./TextTool";
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
  // U8: the LIVE canvas dims — seeded once per plan from the floor-plan
  // query, then owned by the store (a crop replaces them locally until an
  // explicit Save). Every dims consumer below (CanvasStage, Sidebar, the
  // text-tool clamp) reads THIS, never the query, so an unsaved crop is
  // what the editor actually shows. `null` until the seed effect runs — the
  // loading gate below holds the editor back until then.
  const canvasSize = useCanvasStore((state) => state.canvasSize);
  const zoom = useCanvasStore((state) => state.zoom);
  const stagePosition = useCanvasStore((state) => state.stagePosition);
  const dirty = useCanvasStore((state) => state.dirty);
  const setItems = useCanvasStore((state) => state.setItems);
  const applyCrop = useCanvasStore((state) => state.applyCrop);
  const createItemLocal = useCanvasStore((state) => state.createItemLocal);
  // U5: the batched paste commit — one tracked set() per paste, one undo
  // entry however many items the clipboard held.
  const createItemsLocal = useCanvasStore((state) => state.createItemsLocal);
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
  // U7: the TRACKED text-content commit (one history entry per overlay
  // commit; content is the object's substance, unlike untracked styling).
  const updateItemText = useCanvasStore((state) => state.updateItemText);
  const deleteItems = useCanvasStore((state) => state.deleteItems);
  const reorderZIndexItems = useCanvasStore(
    (state) => state.reorderZIndexItems,
  );
  // U5: the context menu's Group/Ungroup entries dispatch straight to the
  // same store actions Ctrl+G/Ctrl+Shift+G use (both no-op appropriately).
  const groupSelection = useCanvasStore((state) => state.groupSelection);
  const ungroupSelection = useCanvasStore((state) => state.ungroupSelection);
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

  // U5: Copy/Cut snapshot the selection into the app-level clipboard (a
  // module value in clipboard.ts — survives plan switches by construction;
  // payload-shaped, so no ids/references ever leak into it). Both read the
  // store at call time (getState) so the handlers stay referentially stable
  // for the shortcut hook however often the selection changes; both no-op
  // on an empty selection WITHOUT clobbering a previous copy.
  const handleCopy = useCallback(() => {
    const { items, selectedItemIds } = useCanvasStore.getState();
    const payload = buildClipboardPayload(selectedItemIds, items);
    if (payload) setClipboard(payload);
  }, []);

  const handleCut = useCallback(() => {
    const { items, selectedItemIds } = useCanvasStore.getState();
    const payload = buildClipboardPayload(selectedItemIds, items);
    if (!payload) return;
    setClipboard(payload);
    // Undoable: `deleteItems` is ONE tracked set(), so undo restores the
    // cut originals — while the clipboard (module state, outside undo per
    // the institutional invariant) keeps pasting either way.
    deleteItems(selectedItemIds);
  }, [deleteItems]);

  // U5/U6: mints a payload's items at a MODEL-space point and commits them
  // — the shared tail of BOTH paste (clipboard payload) and Alt-drop
  // duplicate (payload built from the dragged selection; the clipboard is
  // never touched). Minting + committing follow the stable-id invariants:
  // fresh `local-` ids and fresh `group-` keys every time, one batched
  // tracked set() (one undo entry removes the whole minted set), then the
  // minted set becomes the selection.
  const commitPayloadAt = useCallback(
    (payload: ClipboardPayload, point: Point) => {
      const floorPlan = floorPlanQuery.data;
      if (!floorPlan) return;
      const { items: currentItems } = useCanvasStore.getState();
      const maxZIndex = currentItems.reduce(
        (max, item) => Math.max(max, item.z_index),
        -1,
      );
      const minted = mintClipboardItems(
        payload,
        point,
        floorPlan.id,
        maxZIndex + 1,
      );
      createItemsLocal(minted);
      replaceSelection(minted.map((item) => item.id));
    },
    [floorPlanQuery.data, createItemsLocal, replaceSelection],
  );

  // U5: paste at a MODEL-space point — the context menu passes its
  // right-click stage point, Ctrl+V goes through `handlePasteShortcut`
  // below.
  const handlePasteAt = useCallback(
    (point: Point) => {
      const payload = getClipboard();
      if (!payload) return;
      commitPayloadAt(payload, point);
    },
    [commitPayloadAt],
  );

  // U6: align/distribute — pure patch math over the CURRENT store state
  // (getState, so the handlers stay referentially stable), committed via
  // ONE batched updateItemsGeometry call each: one history entry per
  // action, a single undo reverts the whole alignment. An empty patch
  // list (nothing to move) is skipped outright so no-op clicks can't even
  // reach the store.
  const handleAlignSelection = useCallback(
    (kind: AlignKind) => {
      const { items, selectedItemIds } = useCanvasStore.getState();
      const patches = buildAlignPatches(kind, selectedItemIds, items);
      if (patches.length > 0) updateItemsGeometry(patches);
    },
    [updateItemsGeometry],
  );

  const handleDistributeSelection = useCallback(
    (axis: DistributeAxis) => {
      const { items, selectedItemIds } = useCanvasStore.getState();
      const patches = buildDistributePatches(axis, selectedItemIds, items);
      if (patches.length > 0) updateItemsGeometry(patches);
    },
    [updateItemsGeometry],
  );

  // U5: last observed pointer position (viewport coords) for Ctrl+V's
  // paste-at-cursor. A bare ref write per pointermove — no re-renders; the
  // "is the cursor actually over the canvas" containment check (and the
  // viewport-center fallback when it isn't) happens at paste time inside
  // `resolvePastePoint`.
  const lastPointerClientRef = useRef<Point | null>(null);
  useEffect(() => {
    const trackPointer = (event: PointerEvent) => {
      lastPointerClientRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", trackPointer);
    return () => window.removeEventListener("pointermove", trackPointer);
  }, []);

  const handlePasteShortcut = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.container().getBoundingClientRect();
    const { zoom, stagePosition } = useCanvasStore.getState();
    handlePasteAt(
      resolvePastePoint({
        lastPointer: lastPointerClientRef.current,
        containerRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        zoom,
        stagePosition,
      }),
    );
  }, [handlePasteAt]);

  // U5: the right-click context menu — opened by CanvasStage's contextmenu
  // handler (which applies the right-click selection rule first), closed on
  // click-away/Escape/any action, and positioned at the click's viewport
  // point. Its Paste uses the remembered stage point. The state carries the
  // plan it was opened on so a plan switch (route param change without an
  // unmount, e.g. browser back/forward between two plan URLs) implicitly
  // discards a menu belonging to the previous plan's canvas — a render-time
  // derivation instead of a setState-in-effect. (The CLIPBOARD itself
  // deliberately survives switches: it's a module value in clipboard.ts,
  // and cross-plan paste is the point of R14.)
  const [contextMenu, setContextMenu] = useState<{
    planId: number;
    request: ContextMenuRequest;
  } | null>(null);
  const openContextMenu = useCallback(
    (request: ContextMenuRequest) =>
      setContextMenu({ planId: floorPlanId, request }),
    [floorPlanId],
  );
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const activeContextMenu =
    contextMenu?.planId === floorPlanId ? contextMenu.request : null;

  // U7: the text-editing overlay session. Two shapes, one state:
  // - 'create': a Text-tool click on empty canvas built a DRAFT object
  //   (buildLocalObject-shaped, NOT yet in the store) — it only enters the
  //   store on a non-empty commit, through ONE tracked `createItemLocal`
  //   (so F3's "undo removes it" is a single undo step, and an empty/
  //   Escape'd draft aborts with zero store traffic — no create+delete
  //   history junk).
  // - 'edit': re-editing an EXISTING text object (double-click, or
  //   Text-tool click on it); a changed non-empty commit goes through the
  //   tracked `updateItemText`, empty/unchanged/Escape reverts by simply
  //   closing.
  // Carries the plan it was opened on, same render-time plan-switch
  // discard as the context menu above.
  const [textEditor, setTextEditor] = useState<
    | { planId: number; mode: "create"; draft: CanvasObject }
    | { planId: number; mode: "edit"; itemId: CanvasObject["id"] }
    | null
  >(null);
  const activeTextEditor =
    textEditor?.planId === floorPlanId ? textEditor : null;
  // The object the overlay edits: the uncommitted draft (create) or the
  // LIVE store item (edit — resolved per render, so an item deleted
  // mid-edit, e.g. by an undo, dissolves the overlay instead of editing a
  // ghost).
  const textEditorObject = activeTextEditor
    ? activeTextEditor.mode === "create"
      ? activeTextEditor.draft
      : (items.find((item) => item.id === activeTextEditor.itemId) ?? null)
    : null;

  // Keyboard shortcuts: undo/redo (R15), Ctrl/Cmd+S -> explicit save, and
  // U5's Ctrl/Cmd+C/X/V -> the clipboard handlers above — see
  // `useCanvasShortcuts.ts` (Ctrl+G/Shift+G dispatch internally).
  useCanvasShortcuts(handleSave, {
    onCopy: handleCopy,
    onCut: handleCut,
    onPaste: handlePasteShortcut,
  });

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
    // U8: setItems([]) also resets `canvasSize` to null (its omitted second
    // argument), so an UNSAVED crop's dims can't leak into the next plan —
    // the editor re-gates on the loading branch until the new plan seeds.
    store.setItems([]); // pauses/resumes zundo internally; clears dirty
    store.clearSelection(); // untracked (partialize covers items/canvasSize only)
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
  //
  // U8: the seed now spans TWO queries — items from objectsQuery, canvas
  // dims from floorPlanQuery — so it gates on BOTH having data before the
  // single `setItems(items, canvasSize)` call (one seed, both tracked
  // references stamped inside the same paused bracket). The post-save
  // `['floorPlan', id]` cache dims update can't re-fire this either: same
  // seed-once ref guard.
  useEffect(() => {
    const floorPlan = floorPlanQuery.data;
    if (
      objectsQuery.data &&
      floorPlan &&
      seededForPlanRef.current !== floorPlanId
    ) {
      seededForPlanRef.current = floorPlanId;
      setItems(objectsQuery.data, {
        width: floorPlan.canvas_width,
        height: floorPlan.canvas_height,
      });
    }
  }, [objectsQuery.data, floorPlanQuery.data, floorPlanId, setItems]);

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

  // U7: Text-tool click on empty canvas — build the DRAFT (snapped/clamped
  // like every other creation path; the empty draft's box spans one
  // caret-sized line via measureTextBox's empty-string handling) and open
  // the overlay in create mode. The tool resets to 'select' immediately,
  // matching the shape/line tools' one-shot convention (and preventing the
  // overlay's own outside-click commit from instantly starting a second
  // text at the click point).
  const handleCreateTextAt = useCallback(
    (point: Point) => {
      const floorPlan = floorPlanQuery.data;
      if (!floorPlan) return;
      // U8: clamp against the STORE dims (the live, possibly-cropped
      // canvas), not the query's — read at call time so the handler stays
      // referentially stable across crops.
      const liveCanvasSize = useCanvasStore.getState().canvasSize;
      if (!liveCanvasSize) return;

      const snapped = clampToBounds(
        snapToGrid(point, floorPlan.grid_size),
        0,
        0,
        liveCanvasSize.width,
        liveCanvasSize.height,
      );
      const size = measureTextBox("", DEFAULT_TEXT_STYLING);
      const draft = buildLocalObject(
        floorPlan.id,
        "text",
        { x: snapped.x, y: snapped.y, width: size.width, height: size.height },
        { text: "", ...DEFAULT_TEXT_STYLING },
      );
      setTextEditor({ planId: floorPlan.id, mode: "create", draft });
      // Resets to 'select', NOT 'pan': the overlay's commit re-selects the
      // new text object, and a live selection in the idle pan mode is the
      // stranded, half-interactive state setActiveTool's pan/crop clear is
      // built to prevent (handles draw over an object you can't body-drag
      // or empty-click to deselect). Matches the shape/line one-shot tools,
      // which likewise end with their new object selected.
      setActiveTool("select");
    },
    [floorPlanQuery.data, buildLocalObject, setActiveTool],
  );

  // Escape with no gesture in flight leaves the active tool for the idle
  // pan mode, where a plain drag navigates the canvas.
  const handleExitTool = useCallback(() => setActiveTool("pan"), [setActiveTool]);

  // Clicking an object while panning engages the select tool — the click's
  // own selection lands through CanvasStage's normal routing.
  const handleActivateSelectTool = useCallback(
    () => setActiveTool("select"),
    [setActiveTool],
  );

  // A plain click on empty canvas deselects and returns to the idle pan
  // mode — the closing bracket of the select-tool loop (you enter select by
  // clicking an object, you leave it by clicking empty), and the same
  // outcome as Escape. Only from the select tool: a click-clear while a
  // drawing/crop tool is active must not steal the tool out from under the
  // user.
  const handleBackgroundDeselect = useCallback(() => {
    clearSelection();
    if (useCanvasStore.getState().activeTool === "select") {
      setActiveTool("pan");
    }
  }, [clearSelection, setActiveTool]);

  // U7: re-edit an existing text object (double-click, or Text-tool click
  // on it — CanvasStage's routing already selected it).
  const handleEditTextObject = useCallback(
    (id: CanvasObject["id"]) => {
      setTextEditor({ planId: floorPlanId, mode: "edit", itemId: id });
      setActiveTool("select");
    },
    [floorPlanId, setActiveTool],
  );

  // U7: the overlay's terminal commit. Empty text aborts a creation (no
  // object, no history entry) and reverts a re-edit (previous content
  // stands); an unchanged re-edit is a deliberate no-op (no junk history
  // entry). Non-empty: create-mode commits the draft + content through ONE
  // tracked createItemLocal (a single undo removes the whole text object)
  // and selects it; edit-mode commits through the tracked updateItemText
  // (content + remeasured mirrored box, one entry).
  const handleTextEditCommit = useCallback(
    (text: string) => {
      setTextEditor(null);
      if (!activeTextEditor) return;
      if (text.trim() === "") return;

      if (activeTextEditor.mode === "create") {
        const draft = activeTextEditor.draft;
        const styling = parseTextProperties(draft.properties);
        const size = measureTextBox(text, styling);
        createItemLocal({
          ...draft,
          width: size.width,
          height: size.height,
          properties: { ...draft.properties, text },
        });
        replaceSelection([draft.id]);
        return;
      }

      const item = useCanvasStore
        .getState()
        .items.find((candidate) => candidate.id === activeTextEditor.itemId);
      if (!item) return;
      const current = parseTextProperties(item.properties);
      if (current.text === text) return;
      updateItemText(item.id, text, measureTextBox(text, current));
    },
    [activeTextEditor, createItemLocal, replaceSelection, updateItemText],
  );

  // U7: Escape — create-mode drafts vanish (they never touched the store),
  // re-edits keep their previous content.
  const handleTextEditCancel = useCallback(() => setTextEditor(null), []);

  // U8: a confirmed crop region. ONE tracked store action (applyCrop
  // replaces the shifted items array AND canvasSize together — a single
  // undo restores both), then back to the select tool, matching the
  // one-shot convention of the shape/line tools. Nothing persists here:
  // the cropped dims ride the next explicit Save's PUT.
  const handleApplyCrop = useCallback(
    (region: BoundingBox) => {
      applyCrop(region);
      setActiveTool("select");
    },
    [applyCrop, setActiveTool],
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

  // U8: the stage renders from the STORE's dims, which only exist once the
  // seed-once effect has run (it fires right after the render that had both
  // queries' data, so this state is a single-frame gate in practice — and
  // the plan-switch reset re-arms it so a stale plan's dims never flash).
  if (!canvasSize) {
    return <div role="status">Loading floor plan…</div>;
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
        onAlignSelection={handleAlignSelection}
        onDistributeSelection={handleDistributeSelection}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* U8: canvas dims come from the STORE (live, crop-aware) — only
            grid_size still reads from the floor-plan query (crop doesn't
            touch it). The query dims' sole remaining job is the initial
            seed. */}
        <Sidebar
          getStage={getStage}
          gridSize={floorPlan.grid_size}
          canvasWidth={canvasSize.width}
          canvasHeight={canvasSize.height}
          onDrop={handleDrop}
        />
        {/* Gray workspace backdrop so the (white) canvas reads as a page
            sitting on a surface, the way design tools frame a document —
            `w-fit` keeps the ring/shadow hugging the stage rather than the
            scroll area. */}
        <div className="flex-1 overflow-auto bg-muted p-6">
          <div className="w-fit rounded-sm shadow-md ring-1 ring-border">
          <CanvasStage
            ref={stageRef}
            width={canvasSize.width}
            height={canvasSize.height}
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
            onOpenContextMenu={openContextMenu}
            onDuplicateSelection={commitPayloadAt}
            onCreateTextAt={handleCreateTextAt}
            // Escape with nothing in flight drops the active tool back to
            // the idle pan mode (canvas-tools follow-up).
            onExitTool={handleExitTool}
            onActivateSelectTool={handleActivateSelectTool}
            onBackgroundDeselect={handleBackgroundDeselect}
            onEditTextObject={handleEditTextObject}
            editingItemId={
              activeTextEditor?.mode === "edit" ? activeTextEditor.itemId : null
            }
            onApplyCrop={handleApplyCrop}
          />
          </div>
        </div>
        <PropertyPanel />
      </div>

      {/* U7: the DOM text-editing overlay (fixed-positioned over the
          canvas, like the context menu below). Keyed per editing session so
          a create → immediate re-edit remounts with fresh draft state. */}
      {activeTextEditor && textEditorObject && (
        <TextEditOverlay
          key={`${activeTextEditor.mode}-${String(textEditorObject.id)}`}
          object={textEditorObject}
          mode={activeTextEditor.mode === "create" ? "create" : "edit"}
          zoom={zoom}
          stagePosition={stagePosition}
          getStage={getStage}
          onCommit={handleTextEditCommit}
          onCancel={handleTextEditCancel}
        />
      )}

      {/* U5: the right-click context menu (fixed-positioned DOM, so its
          placement in the tree is irrelevant). Availability is computed at
          render time — opening the menu re-renders this page, so the
          entries always reflect the post-selection-rule store state and the
          clipboard's current content. Every entry closes the menu itself
          (ContextMenu wraps each handler with onClose). */}
      {activeContextMenu && (
        <ContextMenu
          position={activeContextMenu.clientPosition}
          availability={resolveContextMenuAvailability(
            selectedItemIds,
            items,
            hasClipboardContent(),
          )}
          onCopy={handleCopy}
          onCut={handleCut}
          onPaste={() => handlePasteAt(activeContextMenu.stagePoint)}
          onGroup={groupSelection}
          onUngroup={ungroupSelection}
          onAlign={handleAlignSelection}
          onDistribute={handleDistributeSelection}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
