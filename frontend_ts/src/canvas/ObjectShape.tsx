import type Konva from 'konva'
import { Group, Rect, Text } from 'react-konva'
import { clampToBounds, snapToGrid } from './coordinates'
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

interface ObjectShapeProps {
  object: CanvasObject
  isSelected?: boolean
  onSelect?: (id: CanvasObject['id']) => void
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
}

/**
 * Renders one Object as a colored Konva.Rect + Konva.Text label, positioned
 * at x/y/width/height/rotation, draggable for U8's reposition-an-existing-
 * item interaction. Resize/rotate is handled externally by U8's
 * `SelectionTransformer`, attached via the `shapeRef`-registered node.
 *
 * Type-specific rendering (Shapes/Lines) is a later unit (U15/U16) — for
 * now every type, including Shape/Line kinds, renders the same generic
 * rect so the canvas doesn't crash once those types start existing. Lines
 * will eventually get a distinct point-based editing model (U17) instead
 * of drag/Transformer, but no Line-typed items exist yet, so no type
 * branching is needed here yet.
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
}: ObjectShapeProps) {
  const fill = colorForType(object.type)

  const dragBoundFunc = function dragBoundFunc(this: Konva.Node, pos: Point): Point {
    if (gridSize == null || canvasWidth == null || canvasHeight == null) return pos
    const snapped = snapToGrid(pos, gridSize)
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
      onClick={() => onSelect?.(object.id)}
      onTap={() => onSelect?.(object.id)}
      onDragEnd={(event) => {
        const node = event.target
        onGeometryChange?.(object.id, { x: node.x(), y: node.y() })
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
