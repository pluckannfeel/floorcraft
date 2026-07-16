import { Line } from 'react-konva'
import { getRotatedBoundingBox, snapToGrid } from './coordinates'
import type { BoundingBox } from './coordinates'
import { computeLineBoundingBox, isLineTool, parseLinePoints } from './LineTool'
import type { CanvasObject, Point } from './types'

/**
 * U19: alignment/snap guides, following Konva's official "Objects Snapping"
 * sandbox algorithm (Context & Research / Patterns to follow).
 *
 * Mirrors the split established throughout this codebase (`coordinates.ts`,
 * `ShapeTool.tsx`, `LineTool.tsx`, `SelectionTransformer.tsx`): pure,
 * Konva-independent geometry/matching math lives here and is thoroughly unit
 * tested; the thin Konva-prop plumbing (rendering the dashed guide lines)
 * delegates every decision to that pure math.
 *
 * --- Which interactions get alignment guides (implementer's judgment call) ---
 *
 * The plan's Approach describes guides firing on "dragmove/transform" for
 * "any Object". Re-reading `ObjectShape.tsx` (U16) and `LineAnchorHandles.tsx`
 * (U17): Line-typed Objects are explicitly NOT draggable as a whole node —
 * they render a bare `Konva.Line` with no `draggable`/`dragBoundFunc` at all;
 * only their individual points are draggable, via U17's anchor handles, which
 * reposition one point at a time rather than moving/resizing the Line's
 * overall bounding box. Whole-Object drag (`ObjectShape`'s `Group`) and
 * resize (`SelectionTransformer`) therefore only ever apply to catalog
 * Objects and Shapes. Scope decision: alignment guides wire into those two
 * interactions only (drag + Transformer resize of catalog Objects/Shapes).
 * Lines still fully participate as SNAP TARGETS — `boundingBoxForObject`
 * below derives a Line's bbox from its `properties.points` the same way
 * `computeLineBoundingBox` (U16) already does for the stored `x/y/width/
 * height` metadata — but a Line is never itself the object being
 * dragged/resized against those targets, since this codebase gives Lines no
 * whole-node drag/resize interaction to hook guides into. Per-point anchor
 * dragging (U17) is a fundamentally different interaction (repositioning one
 * vertex of a shape, not moving/resizing a rectangle) and is out of scope
 * for this unit's guide-snapping.
 *
 * --- Grid-snap vs. alignment-snap precedence (implementer's judgment call) ---
 *
 * The plan doesn't fully specify precedence between U8's grid-snap and this
 * unit's alignment-snap. Decision: alignment-snap wins per-axis when a match
 * is found within threshold; grid-snap is the fallback for whichever axis
 * has no alignment match. Rationale: an alignment guide is a stronger,
 * intentional signal (aligning to a specific sibling Object's edge) than the
 * generic uniform grid, matching the common pattern in design tools (Figma,
 * Sketch) where smart guides take precedence over a generic grid. The
 * existing snap-then-clamp order (Key Technical Decisions) is preserved:
 * (alignment-or-grid) snap happens first, canvas-bounds clamping always
 * happens last, unconditionally, regardless of which snap source fired.
 */

/** Screen-space snap threshold in pixels (Context & Research / Approach) —
 * converted to model-space units by dividing by the current zoom scale
 * before comparing against model-space bbox coordinates, so the visual snap
 * distance stays consistent across zoom levels (the specific bug the plan's
 * deepening pass flagged: comparing in raw model units would make guides
 * trigger inconsistently as zoom changes). */
export const SNAP_THRESHOLD_SCREEN_PX = 5

export type Axis = 'x' | 'y'
export type EdgeKind = 'start' | 'center' | 'end'

/**
 * Polymorphic geometry-derivation helper (the "shared geometry module" the
 * plan's Key Technical Decisions calls out): computes an Object's
 * model-space bounding box regardless of whether it's a catalog Object/Shape
 * (box comes from `x/y/width/height/rotation`, reusing `coordinates.ts`'s
 * `getRotatedBoundingBox`, U8's existing rotated-bbox math) or a Line (box
 * comes from `properties.points`, reusing `LineTool.tsx`'s
 * `computeLineBoundingBox`, U16's existing points-bbox math). Colocated here
 * rather than added to `coordinates.ts`/`LineTool.tsx` since this unit is the
 * first (and so far only) caller that needs a single polymorphic dispatch
 * across both geometry shapes — the two underlying helpers already exist and
 * are reused as-is, not duplicated.
 */
// Non-component export colocated with the module it belongs to — same
// pattern as `ObjectShape.tsx`'s `colorForType`/`LineTool.tsx`'s helpers.
// eslint-disable-next-line react-refresh/only-export-components
export function boundingBoxForObject(object: CanvasObject): BoundingBox {
  if (isLineTool(object.type)) {
    const points = parseLinePoints(object.properties)
    // A Line with 0-1 points has no meaningful bbox from its points; fall
    // back to the stored x/y metadata (matches `computeLineBoundingBox`'s own
    // "descriptive metadata only" fallback shape) rather than propagating
    // NaN/-Infinity into guide-stop math.
    if (points.length < 2) return { x: object.x, y: object.y, width: 0, height: 0 }
    return computeLineBoundingBox(points)
  }
  return getRotatedBoundingBox({ x: object.x, y: object.y }, object.width, object.height, object.rotation)
}

/** The three edge positions ("stops") a bounding box exposes per axis, per
 * Konva's reference algorithm: the box's start edge, center, and end edge. */
// eslint-disable-next-line react-refresh/only-export-components
export function edgesForBox(box: BoundingBox, axis: Axis): Record<EdgeKind, number> {
  const start = axis === 'x' ? box.x : box.y
  const size = axis === 'x' ? box.width : box.height
  return { start, center: start + size / 2, end: start + size }
}

/**
 * Collects every OTHER Object's edge/center guide "stops" per axis —
 * excludes `excludeId` (the Object currently being dragged/resized) so an
 * Object never snaps against its own edges.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function collectGuideStops(
  objects: CanvasObject[],
  excludeId: CanvasObject['id'],
): { x: number[]; y: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (const object of objects) {
    if (object.id === excludeId) continue
    const box = boundingBoxForObject(object)
    const xEdges = edgesForBox(box, 'x')
    const yEdges = edgesForBox(box, 'y')
    xs.push(xEdges.start, xEdges.center, xEdges.end)
    ys.push(yEdges.start, yEdges.center, yEdges.end)
  }
  return { x: xs, y: ys }
}

export interface AxisSnap {
  /** Which of the dragged/resized box's OWN edges matched a stop. */
  edge: EdgeKind
  /** The model-space coordinate of the matched guide line (where it's drawn). */
  guideValue: number
  /** Model-space delta: adding this to the box's `start` (x or y) aligns
   * `edge` exactly onto `guideValue`. Valid regardless of which `edge`
   * matched, since translating a box's start by `offset` translates every
   * one of its edges by that same `offset` (rigid translation) — this is
   * what a whole-box DRAG needs. Resize needs different handling per `edge`
   * (see `applyAxisSnapToEdge`), since resizing only moves one edge. */
  offset: number
}

/**
 * Finds the single closest stop (across all of `stops` and all three of the
 * box's own edges) within `thresholdModelUnits`, per Konva's reference
 * algorithm's "snap to the closest match" rule. Returns `null` when nothing
 * is within threshold — the "no snap" case.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function findClosestAxisSnap(
  box: BoundingBox,
  axis: Axis,
  stops: number[],
  thresholdModelUnits: number,
): AxisSnap | null {
  const boxEdges = edgesForBox(box, axis)
  let best: AxisSnap | null = null
  let bestDiff = Infinity
  for (const stop of stops) {
    for (const edge of ['start', 'center', 'end'] as const) {
      const diff = Math.abs(boxEdges[edge] - stop)
      if (diff <= thresholdModelUnits && diff < bestDiff) {
        bestDiff = diff
        best = { edge, guideValue: stop, offset: stop - boxEdges[edge] }
      }
    }
  }
  return best
}

export interface AlignmentSnapResult {
  x: AxisSnap | null
  y: AxisSnap | null
}

/**
 * Top-level per-axis alignment-snap computation: converts the screen-space
 * threshold into model-space units by dividing by `zoom` (the zoom-scaling
 * fix the plan's deepening pass specifically flagged), then independently
 * finds the closest snap on each axis (Approach: "snap to the closest match
 * per axis independently" — a horizontal snap to one Object and a vertical
 * snap to a different Object can both apply at once).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function computeAlignmentSnap(
  box: BoundingBox,
  otherObjects: CanvasObject[],
  excludeId: CanvasObject['id'],
  zoom: number,
  thresholdScreenPx: number = SNAP_THRESHOLD_SCREEN_PX,
): AlignmentSnapResult {
  const thresholdModelUnits = thresholdScreenPx / zoom
  const stops = collectGuideStops(otherObjects, excludeId)
  return {
    x: findClosestAxisSnap(box, 'x', stops.x, thresholdModelUnits),
    y: findClosestAxisSnap(box, 'y', stops.y, thresholdModelUnits),
  }
}

export interface GuideLines {
  x: number | null
  y: number | null
}

/**
 * DRAG snapping: combines alignment-snap (preferred) with grid-snap
 * (fallback per axis) — see the module doc's precedence decision — leaving
 * the caller to apply the existing bounds-clamp afterward (snap-then-clamp,
 * unchanged from U8).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function snapDragPosition(
  pos: Point,
  width: number,
  height: number,
  otherObjects: CanvasObject[],
  excludeId: CanvasObject['id'],
  zoom: number,
  gridSize: number,
  thresholdScreenPx: number = SNAP_THRESHOLD_SCREEN_PX,
): { point: Point; guides: GuideLines } {
  const box: BoundingBox = { x: pos.x, y: pos.y, width, height }
  const alignment = computeAlignmentSnap(box, otherObjects, excludeId, zoom, thresholdScreenPx)
  const gridSnapped = snapToGrid(pos, gridSize)

  return {
    point: {
      x: alignment.x ? pos.x + alignment.x.offset : gridSnapped.x,
      y: alignment.y ? pos.y + alignment.y.offset : gridSnapped.y,
    },
    guides: {
      x: alignment.x ? alignment.x.guideValue : null,
      y: alignment.y ? alignment.y.guideValue : null,
    },
  }
}

/**
 * Applies one axis's snap to a RESIZE (as opposed to a rigid drag): only the
 * matched edge moves, not the whole box, so the box's `start`/`size` on that
 * axis adjust differently depending on which edge matched:
 *  - `start` matched: the start edge moves to the guide, the opposite edge
 *    stays put (size shrinks/grows to compensate).
 *  - `end` matched: the end edge moves to the guide, start stays put (size
 *    absorbs the whole delta).
 *  - `center` matched: size stays fixed, the whole box re-centers on the
 *    guide (start shifts by the same offset a drag would use).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function applyAxisSnapToEdge(start: number, size: number, snap: AxisSnap): { start: number; size: number } {
  switch (snap.edge) {
    case 'start':
      return { start: start + snap.offset, size: size - snap.offset }
    case 'end':
      return { start, size: size + snap.offset }
    case 'center':
      return { start: start + snap.offset, size }
  }
}

export interface ResizeBox extends BoundingBox {
  rotation: number
}

/**
 * RESIZE snapping for `SelectionTransformer`'s `boundBoxFunc`. Operates on
 * the UNROTATED `x/y/width/height` Konva's `boundBoxFunc` already hands us
 * (`newBox`), the same convention `ObjectShape.tsx`'s existing
 * `dragBoundFunc` grid-snap/bounds-clamp already uses for drag (rotation is
 * only consulted for the final bounds-clamp check in
 * `constrainTransformBox`, never for repositioning math) — kept consistent
 * with that existing precedent rather than introducing a second, rotation-
 * aware snapping convention.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function snapResizeBox(
  newBox: ResizeBox,
  otherObjects: CanvasObject[],
  excludeId: CanvasObject['id'],
  zoom: number,
  thresholdScreenPx: number = SNAP_THRESHOLD_SCREEN_PX,
): { box: BoundingBox; guides: GuideLines } {
  const alignment = computeAlignmentSnap(newBox, otherObjects, excludeId, zoom, thresholdScreenPx)

  let x = newBox.x
  let width = newBox.width
  if (alignment.x) {
    const adjusted = applyAxisSnapToEdge(x, width, alignment.x)
    x = adjusted.start
    width = adjusted.size
  }

  let y = newBox.y
  let height = newBox.height
  if (alignment.y) {
    const adjusted = applyAxisSnapToEdge(y, height, alignment.y)
    y = adjusted.start
    height = adjusted.size
  }

  return {
    box: { x, y, width, height },
    guides: {
      x: alignment.x ? alignment.x.guideValue : null,
      y: alignment.y ? alignment.y.guideValue : null,
    },
  }
}

/** The "no active guides" value — used both as initial state and to clear
 * guides on `dragend`/`transformend` (Approach: guides are destroyed when the
 * interaction ends). */
// eslint-disable-next-line react-refresh/only-export-components
export const NO_GUIDES: GuideLines = { x: null, y: null }

interface AlignmentGuideLinesProps {
  guides: GuideLines
  width: number
  height: number
}

/**
 * Renders the matched guides as temporary dashed `Konva.Line`s spanning the
 * full canvas on the UI overlay layer (Approach). Purely presentational —
 * `guides` is owned/computed by the caller (`CanvasStage`) from the pure
 * functions above; this component makes no snapping decisions itself.
 */
export function AlignmentGuideLines({ guides, width, height }: AlignmentGuideLinesProps) {
  return (
    <>
      {guides.x != null && (
        <Line
          points={[guides.x, 0, guides.x, height]}
          stroke="#f43f5e"
          strokeWidth={1}
          dash={[4, 4]}
          listening={false}
        />
      )}
      {guides.y != null && (
        <Line
          points={[0, guides.y, width, guides.y]}
          stroke="#f43f5e"
          strokeWidth={1}
          dash={[4, 4]}
          listening={false}
        />
      )}
    </>
  )
}
