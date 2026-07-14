import { Group, Rect, Text } from 'react-konva'
import type { CanvasObject, ObjectType } from './types'

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
  shapeRef?: (node: import('konva/lib/Node').Node | null) => void
}

/**
 * Renders one Object as a colored Konva.Rect + Konva.Text label, positioned
 * at x/y/width/height/rotation. Type-specific rendering (Shapes/Lines) and
 * resize/rotate interaction (Transformer) come in later units (U8, U15,
 * U16) — for now every type, including Shape/Line kinds, renders the same
 * generic rect so the canvas doesn't crash once those types start existing.
 */
export function ObjectShape({ object, isSelected = false, onSelect, shapeRef }: ObjectShapeProps) {
  const fill = colorForType(object.type)

  return (
    <Group
      x={object.x}
      y={object.y}
      rotation={object.rotation}
      ref={shapeRef}
      onClick={() => onSelect?.(object.id)}
      onTap={() => onSelect?.(object.id)}
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
