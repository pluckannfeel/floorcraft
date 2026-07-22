import type { Unit } from './rulers'

/**
 * Shared types for the canvas editor, mirroring the backend `Objects` model
 * (backend/fm_generator/models.py) and `FloorPlan` model/serializer.
 *
 * `type` is the full 14-value enum from the backend: 7 catalog types
 * (sidebar drops), 3 Shapes (U15), 3 Lines (U16), and `text` (canvas-tools
 * U7's first-class auto-sizing text object).
 */

export const CATALOG_TYPES = [
  'outlines',
  'tables',
  'doors',
  'chairs',
  'furnitures',
  'appliances',
  'lighting',
] as const

export type CatalogType = (typeof CATALOG_TYPES)[number]

export const SHAPE_TYPES = ['shape_rectangle', 'shape_square', 'shape_circle'] as const
export type ShapeType = (typeof SHAPE_TYPES)[number]

export const LINE_TYPES = ['line_straight', 'line_curved', 'line_s_curve'] as const
export type LineType = (typeof LINE_TYPES)[number]

/** U7 (canvas-tools): the first-class text object type. A one-member union
 * (not a bare `'text'` literal alias) so it composes into `ObjectType`
 * exactly like the other kind-unions do — `TextTool.ts`'s `isTextType`
 * narrows to it the same way `isLineTool`/`isShapeTool` narrow to theirs. */
export const TEXT_TYPES = ['text'] as const
export type TextType = (typeof TEXT_TYPES)[number]

export type ObjectType = CatalogType | ShapeType | LineType | TextType

/** One row from `GET /api/objects/?floor_plan=<id>`. */
export interface CanvasObject {
  id: number | string
  floor_plan: number
  type: ObjectType
  name: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  z_index: number
  properties: Record<string, unknown>
  /**
   * U4 (canvas-tools): persistent-group membership tag — an opaque,
   * CLIENT-generated key (`group-${crypto.randomUUID()}`, never
   * server-assigned) shared by every member of one flat group; `null` (or
   * absent, for locally-created items that were never grouped) means
   * ungrouped. Client-generated identity is the institutional invariant
   * that keeps group keys valid inside zundo `items` snapshots across
   * saves with zero `serverIdMap` involvement (see
   * docs/solutions/ui-bugs/undo-redo-broken-after-save-2026-07-16.md).
   */
  group_key?: string | null
  created_at?: string
  updated_at?: string
}

/** `GET /api/floor-plans/<id>/` shape (nested `items` omitted here — Objects
 * are fetched separately via `useObjects`). */
export interface FloorPlan {
  id: number
  name: string
  grid_size: number
  canvas_width: number
  canvas_height: number
  /**
   * U1 (canvas-rulers-scale): the plan's real-world scale — how much real
   * distance ONE grid square represents. CANONICAL METERS, always (default
   * 0.5): this scalar is never reinterpreted by `unit`. The rulers convert
   * it to the display unit at label time (`formatMeasurement`), so a metric
   * plan and an imperial plan with the same scalar are the same physical
   * size. First frontend consumer of U1's serialized fields — flowed
   * query -> props exactly like `grid_size` (no store, no undo/dirty).
   */
  real_size_per_grid_square: number
  /**
   * U1: the display unit for measurements (`meters` | `feet_inches`). A
   * presentation choice only — it selects how `real_size_per_grid_square`
   * (and every derived ruler value) is formatted, never what it means.
   * Reuses the `Unit` type from the pure `rulers.ts` module (U2), which
   * mirrors the backend `FloorPlan.unit` choices.
   */
  unit: Unit
  created_at?: string
  updated_at?: string
}

export interface Point {
  x: number
  y: number
}

