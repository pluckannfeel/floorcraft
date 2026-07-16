import type Konva from 'konva'
import { Group, Line, Rect, Text } from 'react-konva'
import { NO_GUIDES, snapDragPosition } from './AlignmentGuides'
import type { GuideLines } from './AlignmentGuides'
import { clampToBounds } from './coordinates'
import { flattenPoints, getEffectiveTension, isLineTool, parseLinePoints } from './LineTool'
import type { CanvasObject, ObjectType, Point } from './types'

/**
 * Color palette for all 13 Object types (Key Technical Decisions: canvas-only
 * visual differentiation via color + text label is an accepted limitation
 * for this pass — no icons yet).
 *
 * Only the 7 catalog types are ever created in this unit (U7); Shape/Line
 * types are included so ObjectShape renders generically without crashing
 * once U15/U16 start creating them (they still render as a plain colored
 * rect for now — type-specific rendering/Transformer support comes later).
 */
const TYPE_COLORS: Record<ObjectType, string> = {
  outlines: '#6b7280',
  tables: '#b45309',
  doors: '#0891b2',
  chairs: '#7c3aed',
  furnitures: '#c2410c',
  appliances: '#0d9488',
  lighting: '#ca8a04',
  shape_rectangle: '#2563eb',
  shape_square: '#1d4ed8',
  shape_circle: '#1e40af',
  line_straight: '#dc2626',
  line_curved: '#b91c1c',
  line_s_curve: '#991b1b',
}

const DEFAULT_COLOR = '#4b5563'

// Non-component export colocated with the palette it reads from; same
// pattern as AuthContext.tsx's `useAuth` hook export.
// eslint-disable-next-line react-refresh/only-export-components
export function colorForType(type: ObjectType): string {
  return TYPE_COLORS[type] ?? DEFAULT_COLOR
}

/**
 * U1 (canvas-tools): the modifier keys held during a select click/tap,
 * reported alongside the id so `CanvasStage`'s routing can distinguish
 * plain click (replace selection) from ctrl/meta+click (toggle membership).
 * ObjectShape itself stays selection-policy-free — it only relays what the
 * pointer event carried.
 */
export interface SelectionClickModifiers {
  ctrlKey: boolean
  metaKey: boolean
}

interface ObjectShapeProps {
  object: CanvasObject
  isSelected?: boolean
  onSelect?: (id: CanvasObject['id'], modifiers?: SelectionClickModifiers) => void
  /** Registers/unregisters this node's Konva ref with a parent-owned
   * `Map<id, Konva.Node>` — used by U8's SelectionTransformer. Optional so
   * this unit doesn't need that machinery yet. */
  shapeRef?: (node: Konva.Node | null) => void
  /** Grid size and canvas bounds for U8's reposition-drag `dragBoundFunc`
   * (grid-snap + bounds-clamp), same `coordinates.ts` helpers U7 already
   * uses for sidebar-drop placement. Optional so tests that don't exercise
   * dragging can omit them. */
  gridSize?: number
  canvasWidth?: number
  canvasHeight?: number
  /** Commits a repositioned-via-drag item's final x/y to the store, called
   * on `dragend` (U8's R13 "drag", distinct from U7's sidebar-to-canvas
   * creation drag). */
  onGeometryChange?: (id: CanvasObject['id'], patch: Partial<Pick<CanvasObject, 'x' | 'y'>>) => void
  /** U19: every Object currently on the floor plan (including this one —
   * `snapDragPosition` excludes `object.id` internally), used to compute
   * alignment-guide "stops" from every OTHER Object's bbox edges/center.
   * Optional so tests/callers that don't exercise alignment guides can omit
   * it, in which case no alignment-snap is attempted (grid-snap only, same
   * as before this unit). */
  allObjects?: CanvasObject[]
  /** U11's current Stage zoom — needed to convert U19's 5px screen-space
   * snap threshold into model-space units. Defaults to 1 (matches
   * `CanvasStage`'s own zoom default) so callers that don't exercise zoom
   * still get correct alignment-snap behavior. */
  zoom?: number
  /** U19: reports the currently-matched guide lines (or `NO_GUIDES`) up to
   * `CanvasStage` for rendering on the UI overlay layer, and to clear them
   * on `dragend`. */
  onAlignmentGuidesChange?: (guides: GuideLines) => void
}

/**
 * Renders one Object as a colored Konva.Rect + Konva.Text label, positioned
 * at x/y/width/height/rotation, draggable for U8's reposition-an-existing-
 * item interaction. Resize/rotate is handled externally by U8's
 * `SelectionTransformer`, attached via the `shapeRef`-registered node.
 *
 * Catalog Objects and Shapes render this generic Rect+label. Line-typed
 * Objects (U16) are structurally different — they have no meaningful
 * width/height "box," they're defined by `properties.points` — so they
 * branch to a dedicated `Konva.Line` render below instead.
 *
 * The Group is given an explicit `width`/`height` (matching the Rect's)
 * rather than leaving Konva to infer 0 — `SelectionTransformer` reads
 * `node.width()`/`node.height()` directly when folding resize scale back
 * into stored dimensions, which requires the Group to report its true size.
 */
export function ObjectShape({
  object,
  isSelected = false,
  onSelect,
  shapeRef,
  gridSize,
  canvasWidth,
  canvasHeight,
  onGeometryChange,
  allObjects,
  zoom = 1,
  onAlignmentGuidesChange,
}: ObjectShapeProps) {
  const fill = colorForType(object.type)

  // U16: Lines are defined by `properties.points`, not x/y/width/height —
  // rendered as a raw/tensioned Konva.Line, not the generic Rect+label
  // below. Not draggable as a whole Group (unlike catalog Objects/Shapes):
  // its points are absolute canvas coordinates rendered with the Group at
  // its natural origin, so a whole-node drag would desync the Group's
  // x/y from the points it renders. Per Key Technical Decisions, Lines get
  // their own point-based editing model (U17's `LineAnchorHandles`) instead
  // of the Transformer/whole-node-drag pattern every other type uses.
  if (isLineTool(object.type)) {
    const points = parseLinePoints(object.properties)
    const tension = getEffectiveTension(object.type, points.length)
    return (
      <Line
        ref={shapeRef}
        points={flattenPoints(points)}
        stroke={fill}
        strokeWidth={isSelected ? 3 : 2}
        tension={tension}
        lineCap="round"
        lineJoin="round"
        hitStrokeWidth={12}
        onClick={(event) =>
          onSelect?.(object.id, { ctrlKey: event.evt.ctrlKey, metaKey: event.evt.metaKey })
        }
        onTap={(event) =>
          onSelect?.(object.id, { ctrlKey: event.evt.ctrlKey, metaKey: event.evt.metaKey })
        }
      />
    )
  }

  // U19: computed on every dragmove frame (Konva calls `dragBoundFunc` on
  // each move, not just at dragend). Alignment-snap (preferred) or
  // grid-snap (fallback per axis, see `AlignmentGuides.tsx`'s module doc for
  // the precedence rationale) runs first, then the existing bounds-clamp
  // always runs last — snap-then-clamp order is unchanged from U8. The
  // matched guides (if any) are reported up to `CanvasStage` as a side
  // effect so they render for this same frame; Konva already re-invokes this
  // function every dragmove frame regardless, so this doesn't add extra
  // render passes beyond what dragging already causes.
  const dragBoundFunc = function dragBoundFunc(this: Konva.Node, pos: Point): Point {
    if (gridSize == null || canvasWidth == null || canvasHeight == null) return pos
    const { point: snapped, guides } = snapDragPosition(
      pos,
      object.width,
      object.height,
      allObjects ?? [],
      object.id,
      zoom,
      gridSize,
    )
    onAlignmentGuidesChange?.(guides)
    return clampToBounds(snapped, object.width, object.height, canvasWidth, canvasHeight)
  }

  return (
    <Group
      x={object.x}
      y={object.y}
      width={object.width}
      height={object.height}
      rotation={object.rotation}
      ref={shapeRef}
      draggable
      dragBoundFunc={dragBoundFunc}
      onClick={(event) =>
        onSelect?.(object.id, { ctrlKey: event.evt.ctrlKey, metaKey: event.evt.metaKey })
      }
      onTap={(event) =>
        onSelect?.(object.id, { ctrlKey: event.evt.ctrlKey, metaKey: event.evt.metaKey })
      }
      onDragEnd={(event) => {
        const node = event.target
        onGeometryChange?.(object.id, { x: node.x(), y: node.y() })
        // U19: destroy the temporary guide lines once the drag interaction
        // ends (Approach: guides are removed on dragend/transformend).
        onAlignmentGuidesChange?.(NO_GUIDES)
      }}
    >
      <Rect
        width={object.width}
        height={object.height}
        fill={fill}
        stroke={isSelected ? '#111827' : undefined}
        strokeWidth={isSelected ? 2 : 0}
        cornerRadius={2}
      />
      <Text
        text={object.name || object.type}
        width={object.width}
        height={object.height}
        align="center"
        verticalAlign="middle"
        fontSize={11}
        fill="#ffffff"
        listening={false}
      />
    </Group>
  )
}
