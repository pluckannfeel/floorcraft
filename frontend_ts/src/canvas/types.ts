/**
 * Shared types for the canvas editor, mirroring the backend `Objects` model
 * (backend/fm_generator/models.py) and `FloorPlan` model/serializer.
 *
 * `type` is the full 13-value enum from the backend, but this unit (U7) only
 * ever creates catalog types via the sidebar; Shape/Line creation lands in
 * U15/U16.
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

export type ObjectType = CatalogType | ShapeType | LineType

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
  created_at?: string
  updated_at?: string
}

export interface Point {
  x: number
  y: number
}

