import { boundingBoxForObject } from './AlignmentGuides'
import { containerToStagePoint, unionBoundingBoxes } from './coordinates'
import { computeLineBoundingBox, isLineTool, parseLinePoints } from './LineTool'
import type { CanvasObject, Point } from './types'

/**
 * U5 (canvas-tools plan): the app-level clipboard.
 *
 * The clipboard is a MODULE-LEVEL value, deliberately outside the zustand
 * store (a plan Key Technical Decision, backed by the institutional
 * invariant in docs/solutions/ui-bugs/undo-redo-broken-after-save-2026-07-16.md
 * that selection and clipboard stay OUT of `partialize`): the canvasStore is
 * reset wholesale on every floor-plan switch (`CanvasEditorPage`'s
 * `[floorPlanId]` reset effect), so anything living in it would die with the
 * switch — a module value survives by construction, which is exactly what
 * R14's cross-plan paste needs.
 *
 * What it holds is equally deliberate: PAYLOAD-SHAPED snapshots
 * (type/name/geometry/properties/group structure + offsets relative to the
 * copied set's bounding-box origin) — NEVER live item references, item ids,
 * or original group keys. Paste mints everything identity-shaped fresh
 * (`local-` ids, `group-` keys), so repeat-paste can't collide with itself
 * and cross-plan paste can't leak one plan's identity into another
 * (`serverIdMap` never gets involved — pasted items are ordinary local
 * creates that round-trip through the next save's `id_map` like any sidebar
 * drop).
 *
 * Line members get special handling (plan doc-review hardening): a Line's
 * `properties.points` are ABSOLUTE canvas coordinates, so copying
 * `properties` verbatim would paste the line back at its original position
 * (and, cross-plan, in a coordinate space that means nothing there). The
 * snapshot stores points RELATIVE to the set's bbox origin;
 * `mintClipboardItems` re-absolutizes them at the paste point and recomputes
 * the line's descriptive x/y/width/height metadata via
 * `computeLineBoundingBox` — the same metadata convention `handleCreateLine`
 * and `buildGroupDragPatches` already follow.
 */

/**
 * One copied item, positioned relative to the copied set's bounding-box
 * origin. `properties` is a deep copy (never shared with the live item);
 * for Line-typed entries its `points` have been rebased to set-relative
 * coordinates. `groupIndex` encodes the set's internal group PARTITION
 * (0, 1, … in encounter order; `null` = ungrouped) instead of the original
 * `group_key` string, so not even the key leaks into the clipboard — paste
 * mints one fresh `group-` key per index.
 */
export interface ClipboardEntry {
  type: CanvasObject['type']
  name: string
  /** The item's stored x/y relative to the set's bbox origin. (For Lines
   * this mirrors the descriptive metadata; the authoritative geometry is
   * the relative `properties.points`.) */
  offset: Point
  width: number
  height: number
  rotation: number
  properties: Record<string, unknown>
  groupIndex: number | null
}

/**
 * A full clipboard snapshot. `entries` are ordered by the copied set's
 * INTERNAL z-order (ascending `z_index`, then `id` — the same tiebreak
 * `sortObjectsByZIndex` renders by), so paste can renumber them contiguously
 * on top of the target plan while preserving how they stacked relative to
 * each other (plan interaction default: "pasted sets go on top preserving
 * internal order").
 */
export interface ClipboardPayload {
  entries: ClipboardEntry[]
}

let clipboard: ClipboardPayload | null = null

/** Replaces the clipboard's contents (Copy/Cut). */
export function setClipboard(payload: ClipboardPayload): void {
  clipboard = payload
}

/** The current clipboard snapshot, or `null` when nothing was ever copied. */
export function getClipboard(): ClipboardPayload | null {
  return clipboard
}

/** Whether Paste has anything to paste — drives the context-menu entry's
 * disabled state. */
export function hasClipboardContent(): boolean {
  return clipboard != null
}

/** Empties the clipboard. Exists for tests (module state would otherwise
 * leak between cases); the app itself never clears — a copied set stays
 * pasteable for the whole session, across plan switches. */
export function clearClipboard(): void {
  clipboard = null
}

/**
 * Builds a payload-shaped snapshot of the current selection (Copy, and the
 * copy half of Cut). Returns `null` when the selection matches no items —
 * the caller leaves the existing clipboard untouched (copying nothing must
 * not destroy a previous copy).
 *
 * Pure: reads the given arrays only, writes nothing (module state included —
 * the caller decides whether the result becomes THE clipboard via
 * `setClipboard`), and deep-copies `properties` so later edits to the live
 * items can't mutate the snapshot retroactively.
 */
export function buildClipboardPayload(
  selectedItemIds: CanvasObject['id'][],
  items: CanvasObject[],
): ClipboardPayload | null {
  const idSet = new Set(selectedItemIds)
  const selected = items
    .filter((item) => idSet.has(item.id))
    .sort((a, b) => {
      if (a.z_index !== b.z_index) return a.z_index - b.z_index
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  if (selected.length === 0) return null

  const setBox = unionBoundingBoxes(selected.map(boundingBoxForObject))
  // unionBoundingBoxes only returns null for an empty list, and `selected`
  // is non-empty here — the fallback is pure defensiveness.
  const origin: Point = setBox ? { x: setBox.x, y: setBox.y } : { x: 0, y: 0 }

  const groupIndexByKey = new Map<string, number>()
  const entries = selected.map((item): ClipboardEntry => {
    let groupIndex: number | null = null
    if (item.group_key != null) {
      const existing = groupIndexByKey.get(item.group_key)
      groupIndex = existing ?? groupIndexByKey.size
      if (existing === undefined) groupIndexByKey.set(item.group_key, groupIndex)
    }

    const properties = structuredClone(item.properties)
    if (isLineTool(item.type)) {
      const points = parseLinePoints(item.properties)
      if (points.length > 0) {
        properties.points = points.map((point) => ({
          x: point.x - origin.x,
          y: point.y - origin.y,
        }))
      }
    }

    return {
      type: item.type,
      name: item.name,
      offset: { x: item.x - origin.x, y: item.y - origin.y },
      width: item.width,
      height: item.height,
      rotation: item.rotation,
      properties,
      groupIndex,
    }
  })

  return { entries }
}

/**
 * Mints brand-new `CanvasObject`s from a clipboard payload — the paste half.
 *
 * - Fresh identity throughout: every item gets a `local-${crypto.randomUUID()}`
 *   id (the `buildLocalObject` convention — translation to a server row
 *   happens only at the save boundary via `id_map`), and each distinct
 *   `groupIndex` gets ONE fresh `group-${crypto.randomUUID()}` key, so
 *   internal grouping is preserved but never shares identity with the
 *   original (or with a previous paste of the same payload).
 * - Positioning: the set's bbox origin lands at `pastePoint`; every entry
 *   keeps its stored offset from that origin, so relative arrangement is
 *   preserved exactly. Line entries re-absolutize their relative points
 *   against `pastePoint` and recompute their descriptive bbox metadata.
 * - Stacking: entries are assigned `zIndexStart`, `zIndexStart + 1`, … in
 *   payload order (the copied set's internal z-order) — the caller passes
 *   `max(z_index) + 1` so the whole set lands on top.
 *
 * The caller commits the result through the store's batched
 * `createItemsLocal` (ONE tracked set() — one undo entry per paste) and
 * selects the minted ids.
 */
export function mintClipboardItems(
  payload: ClipboardPayload,
  pastePoint: Point,
  floorPlanId: number,
  zIndexStart: number,
): CanvasObject[] {
  const groupKeyByIndex = new Map<number, string>()
  const keyForGroupIndex = (index: number): string => {
    const existing = groupKeyByIndex.get(index)
    if (existing !== undefined) return existing
    const fresh = `group-${crypto.randomUUID()}`
    groupKeyByIndex.set(index, fresh)
    return fresh
  }

  return payload.entries.map((entry, index) => {
    const properties = structuredClone(entry.properties)
    let geometry = {
      x: pastePoint.x + entry.offset.x,
      y: pastePoint.y + entry.offset.y,
      width: entry.width,
      height: entry.height,
    }
    if (isLineTool(entry.type)) {
      const relativePoints = parseLinePoints(entry.properties)
      if (relativePoints.length > 0) {
        const points = relativePoints.map((point) => ({
          x: pastePoint.x + point.x,
          y: pastePoint.y + point.y,
        }))
        properties.points = points
        geometry = { ...geometry, ...computeLineBoundingBox(points) }
      }
    }

    return {
      id: `local-${crypto.randomUUID()}`,
      floor_plan: floorPlanId,
      type: entry.type,
      name: entry.name,
      ...geometry,
      rotation: entry.rotation,
      z_index: zIndexStart + index,
      properties,
      group_key: entry.groupIndex != null ? keyForGroupIndex(entry.groupIndex) : null,
    }
  })
}

/** The subset of a DOMRect `resolvePastePoint` needs — plain numbers so the
 * helper stays Konva/DOM-free and jsdom-testable. */
export interface PastePointContainerRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ResolvePastePointArgs {
  /** Last known pointer position in CLIENT (viewport) coordinates, or
   * `null` when no pointer position was ever observed. */
  lastPointer: Point | null
  /** The stage container element's bounding client rect. */
  containerRect: PastePointContainerRect
  /** The browser viewport (window.innerWidth/innerHeight). */
  viewportWidth: number
  viewportHeight: number
  zoom: number
  stagePosition: Point
}

/**
 * Where a KEYBOARD paste (Ctrl/Cmd+V) lands, per the plan's interaction
 * defaults: the current mouse position when the cursor is over the canvas,
 * or the VIEWPORT CENTER of the canvas when it isn't. (Context-menu paste
 * never calls this — it uses the right-click's stage point directly.)
 *
 * "Over the canvas" means inside the stage container's client rect AND
 * inside the browser viewport (a canvas area scrolled out of view doesn't
 * count). The fallback center is the center of the VISIBLE part of the
 * canvas (container rect intersected with the viewport), so a zoomed-in or
 * scrolled editor pastes into what the user is actually looking at; if the
 * intersection is somehow empty, the raw container center is used.
 *
 * Returns MODEL/stage coordinates (via `containerToStagePoint` — the same
 * pure conversion the marquee uses).
 */
export function resolvePastePoint({
  lastPointer,
  containerRect,
  viewportWidth,
  viewportHeight,
  zoom,
  stagePosition,
}: ResolvePastePointArgs): Point {
  const right = containerRect.left + containerRect.width
  const bottom = containerRect.top + containerRect.height

  if (
    lastPointer &&
    lastPointer.x >= containerRect.left &&
    lastPointer.x <= right &&
    lastPointer.y >= containerRect.top &&
    lastPointer.y <= bottom &&
    lastPointer.x >= 0 &&
    lastPointer.x <= viewportWidth &&
    lastPointer.y >= 0 &&
    lastPointer.y <= viewportHeight
  ) {
    return containerToStagePoint(
      { x: lastPointer.x - containerRect.left, y: lastPointer.y - containerRect.top },
      zoom,
      stagePosition,
    )
  }

  // Visible-canvas center: intersect the container rect with the viewport.
  const visibleLeft = Math.max(containerRect.left, 0)
  const visibleTop = Math.max(containerRect.top, 0)
  const visibleRight = Math.min(right, viewportWidth)
  const visibleBottom = Math.min(bottom, viewportHeight)
  const hasVisibleArea = visibleRight > visibleLeft && visibleBottom > visibleTop
  const center: Point = hasVisibleArea
    ? { x: (visibleLeft + visibleRight) / 2, y: (visibleTop + visibleBottom) / 2 }
    : { x: containerRect.left + containerRect.width / 2, y: containerRect.top + containerRect.height / 2 }

  return containerToStagePoint(
    { x: center.x - containerRect.left, y: center.y - containerRect.top },
    zoom,
    stagePosition,
  )
}
