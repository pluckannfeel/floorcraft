import { useCallback, useState } from 'react'
import { Line } from 'react-konva'
import { clampToBounds, snapToGrid } from './coordinates'
import type { LineType, Point } from './types'

/**
 * U16: click-per-point Line drawing (`line_straight`/`line_curved`/
 * `line_s_curve`), driven by `activeTool` (same field U15's ShapeTool
 * reads), but a click-per-point/finish-on-double-click-or-Escape state
 * machine instead of ShapeTool's click-drag-to-size.
 *
 * Mirrors ShapeTool.tsx's split: pure, Konva-independent geometry/tension
 * math lives here and is thoroughly unit tested; the thin Konva-prop
 * plumbing (reading click positions, rendering a live preview) delegates
 * every decision to that pure math.
 */

/** Narrows `ActiveTool`/`ObjectType` to the three line-drawing/line-rendering
 * tool types. Reused by `ObjectShape.tsx` to decide whether a committed
 * Object should render as a `Line` instead of the generic Rect. Non-component
 * export colocated with the module it belongs to — same pattern as
 * `ShapeTool.tsx`'s `isShapeTool`. */
// eslint-disable-next-line react-refresh/only-export-components
export function isLineTool(tool: string): tool is LineType {
  return tool === 'line_straight' || tool === 'line_curved' || tool === 'line_s_curve'
}

/**
 * Fixed tension presets per curve style (Key Technical Decisions: numeric
 * tension is never user-adjustable). `line_straight` is always 0 — straight
 * Lines are never splined, regardless of point count.
 */
const TENSION_PRESETS: Record<LineType, number> = {
  line_straight: 0,
  line_curved: 0.4,
  line_s_curve: 0.8,
}

/** Below this point count, a cardinal spline (Konva's `tension` mode) is
 * prone to visible overshoot near the endpoints — a known, sparse-point-set
 * behavior flagged in the plan's Context & Research. */
const OVERSHOOT_RISK_POINT_THRESHOLD = 4

/** Tension cap applied for curved/S-curve Lines with fewer than
 * `OVERSHOOT_RISK_POINT_THRESHOLD` points — well below both presets (0.4/0.8)
 * so the reduced spline stays visibly closer to the raw polyline, avoiding
 * the overshoot artifact rather than merely softening it. */
const REDUCED_TENSION_CAP = 0.2

/**
 * Computes the `tension` value a finished Line should render with.
 *
 * `line_straight` is always `0` (never splined, regardless of point count).
 * `line_curved`/`line_s_curve` use their fixed preset once the Line has at
 * least `OVERSHOOT_RISK_POINT_THRESHOLD` points; below that, tension is
 * capped at `REDUCED_TENSION_CAP` instead of the full preset.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function getEffectiveTension(curveType: LineType, pointCount: number): number {
  const preset = TENSION_PRESETS[curveType]
  if (preset === 0) return 0
  return pointCount < OVERSHOOT_RISK_POINT_THRESHOLD ? Math.min(preset, REDUCED_TENSION_CAP) : preset
}

/** The `curve_style` value stored in `properties` for a given Line `type` —
 * intentionally a plain derivation of `type` (its `line_` prefix stripped),
 * not independent user-facing state (Scope Boundaries: no user-adjustable
 * curve intensity/style beyond the toolbar's three fixed tools). Kept as a
 * distinct `properties.curve_style` key rather than relying on `type` alone
 * because the backend serializer (`ObjectSerializer._validate_line_properties`,
 * U14) requires `properties.curve_style` to be present/truthy for curved
 * line types independently of `type`. */
// eslint-disable-next-line react-refresh/only-export-components
export function curveStyleForType(type: LineType): 'straight' | 'curved' | 's_curve' {
  return type.replace('line_', '') as 'straight' | 'curved' | 's_curve'
}

/** Flattens an `{x, y}[]` points array into Konva `Line`'s expected flat
 * `[x1, y1, x2, y2, ...]` number array. */
// eslint-disable-next-line react-refresh/only-export-components
export function flattenPoints(points: Point[]): number[] {
  return points.flatMap((point) => [point.x, point.y])
}

/** Inverse of `flattenPoints`: pairs Konva `Line`'s flat
 * `[x1, y1, x2, y2, ...]` number array back into `{x, y}[]` — U3 reads a
 * live Line node's `points()` this way before mapping them through a
 * finished multi-transform (`applyNodeTransformToPoints`). A trailing
 * unpaired number (malformed input) is dropped rather than producing a
 * point with an `undefined` coordinate. */
// eslint-disable-next-line react-refresh/only-export-components
export function pairPoints(flat: number[]): Point[] {
  const points: Point[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) {
    points.push({ x: flat[i], y: flat[i + 1] })
  }
  return points
}

/**
 * Safely reads a `points` array back out of an Object's `properties` JSON
 * (as read from the store/API, typed as `Record<string, unknown>`). Returns
 * `[]` for anything malformed rather than throwing, since `properties` has
 * no DB-level shape enforcement (only serializer-level, per U14) and this
 * runs on every render of every Line-typed Object.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function parseLinePoints(properties: Record<string, unknown> | undefined): Point[] {
  const raw = properties?.points
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is Point =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Point).x === 'number' &&
      typeof (entry as Point).y === 'number',
  )
}

/**
 * Computes the axis-aligned bounding box of a Line's points — used as the
 * committed Object's top-level `x`/`y`/`width`/`height` (the shared
 * `Objects` model requires these on every row regardless of type, per U14).
 * `properties.points` remains the actual source of truth for rendering
 * (per the plan's Key Technical Decision on the future polymorphic
 * geometry-derivation module); this bounding box is descriptive metadata
 * only, not re-derived from on every render the way `ObjectShape` reads
 * `properties.points` directly.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function computeLineBoundingBox(points: Point[]): { x: number; y: number; width: number; height: number } {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  }
}

export interface LineDrawState {
  type: LineType
  points: Point[]
}

interface UseLineToolArgs {
  gridSize: number
  canvasWidth: number
  canvasHeight: number
  /** Called with the finished points array on a successful finish (>= 2
   * points placed). The caller is responsible for creating the item and
   * resetting `activeTool` back to `'select'` — same delegation pattern as
   * `ShapeTool.tsx`'s `useShapeTool`'s `onCommit`. */
  onCommit: (type: LineType, points: Point[]) => void
}

/**
 * Drives the draw-a-Line interaction: each call to `addPoint` appends a
 * snapped/clamped point to the in-progress array (or starts a new one if
 * not currently drawing, or the tool changed mid-draw); `finishDraw` ends
 * the draw, committing via `onCommit` only if at least 2 points were placed
 * — 0 or 1 points silently discards instead (the plan's explicit "does not
 * create a Line" edge case), so both the double-click and Escape finish
 * paths can share this single function without duplicating the
 * minimum-points check.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useLineTool({ gridSize, canvasWidth, canvasHeight, onCommit }: UseLineToolArgs) {
  const [draw, setDraw] = useState<LineDrawState | null>(null)

  const addPoint = useCallback(
    (type: LineType, point: Point) => {
      // A point has no width/height of its own; clamping with 0/0 simply
      // keeps the point itself within [0, canvasWidth] x [0, canvasHeight],
      // matching `clampToBounds`'s existing snap-then-clamp convention.
      const snapped = clampToBounds(snapToGrid(point, gridSize), 0, 0, canvasWidth, canvasHeight)
      setDraw((current) => {
        if (current && current.type === type) {
          return { ...current, points: [...current.points, snapped] }
        }
        // Not currently drawing, or the active tool changed mid-draw
        // (shouldn't normally happen since switching tools should finish/
        // cancel the prior draw, but starting fresh here is the safe
        // fallback rather than silently mixing point arrays across types).
        return { type, points: [snapped] }
      })
    },
    [gridSize, canvasWidth, canvasHeight],
  )

  const finishDraw = useCallback(() => {
    setDraw((current) => {
      if (current && current.points.length >= 2) {
        onCommit(current.type, current.points)
      }
      return null
    })
  }, [onCommit])

  const cancelDraw = useCallback(() => setDraw(null), [])

  return {
    isDrawing: draw != null,
    drawType: draw?.type ?? null,
    points: draw?.points ?? [],
    addPoint,
    finishDraw,
    cancelDraw,
  }
}

interface LinePreviewProps {
  points: Point[]
}

/** Live in-progress preview rendered while a Line is being drawn — always
 * `tension: 0` (a raw polyline), per the plan's Key Technical Decision: the
 * tensioned spline is only applied once the Line is finished, sidestepping
 * Konva's reported issue where incrementally updating `points` on an
 * already-tensioned `Line` can render incorrectly. */
export function LinePreview({ points }: LinePreviewProps) {
  if (points.length < 2) return null
  return (
    <Line
      points={flattenPoints(points)}
      stroke="#dc2626"
      strokeWidth={2}
      dash={[4, 4]}
      tension={0}
      lineCap="round"
      lineJoin="round"
      listening={false}
    />
  )
}
