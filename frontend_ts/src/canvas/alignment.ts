import { boundingBoxForObject } from './AlignmentGuides'
import { translatePoints, unionBoundingBoxes } from './coordinates'
import type { BoundingBox } from './coordinates'
import { computeLineBoundingBox, isLineTool, parseLinePoints } from './LineTool'
import type { ItemGeometryPatch } from '../state/canvasStore'
import type { CanvasObject, Point } from './types'

/**
 * U6 (canvas-tools plan): pure align/distribute math over rotated bounding
 * boxes. No Konva, no store — every function here takes the selection and
 * the items list and returns `ItemGeometryPatch` batches for the store's
 * batched `updateItemsGeometry` (ONE call per action → one history entry
 * per align/distribute gesture, the same one-entry-per-gesture contract
 * U3's group drag established).
 *
 * Geometry sources follow the codebase's established polymorphic dispatch:
 * every box comes from `boundingBoxForObject` (rotated objects contribute
 * their rotated AABB via `getRotatedBoundingBox`; Lines derive theirs from
 * `properties.points`), and translations are rigid — box members patch
 * x/y, Line members patch `points` (plus recomputed descriptive bbox
 * metadata), exactly like `buildGroupDragPatches`.
 *
 * GROUPS collapse to one box (plan: "group-aware alignment treats a group
 * as one unit"): the selection is PARTITIONED by `group_key` — every
 * selected member sharing a key forms ONE unit that moves rigidly as a
 * whole, and each loose member is its own unit. Align/distribute math then
 * operates on UNITS, so distribute's "3+ objects" requirement counts BOXES
 * (2 groups + 1 loose item = 3 boxes), not raw items.
 */

/** The six align actions — horizontal edge/center alignment (`left`/
 * `centerH`/`right` translate on x) and vertical (`top`/`middleV`/`bottom`
 * translate on y), always against the SELECTION's collective extremes. */
export type AlignKind = 'left' | 'centerH' | 'right' | 'top' | 'middleV' | 'bottom'

/** The two distribute actions: space the units' box CENTERS evenly between
 * the two extreme centers along the given axis. */
export type DistributeAxis = 'horizontal' | 'vertical'

/**
 * One alignment unit: a whole selected group (every selected member sharing
 * one `group_key`) or a single loose selected item. `box` is the union of
 * the members' rotated/points-derived bounding boxes; the unit only ever
 * moves rigidly (one shared delta for all `members`).
 */
export interface SelectionUnit {
  members: CanvasObject[]
  box: BoundingBox
}

/**
 * Partitions the selection into alignment units (see `SelectionUnit`).
 * Units are returned in `items` (encounter) order — deterministic for
 * tests, matching the ordered-selection conventions elsewhere. Selection
 * ids that match no item are ignored (mid-delete race safety, same as
 * every other selection consumer).
 *
 * Note the partition covers exactly the SELECTED members of a key — the
 * selection is the literal operand set (the plan's U1/U4 contract), so a
 * partially-selected group (only reachable via member-mode-style
 * selections) contributes only its selected members as one unit; nothing
 * here re-expands group membership.
 */
export function partitionSelectionUnits(
  selectedItemIds: CanvasObject['id'][],
  items: CanvasObject[],
): SelectionUnit[] {
  const idSet = new Set(selectedItemIds)
  const unitMembers: CanvasObject[][] = []
  const groupUnitIndexByKey = new Map<string, number>()
  for (const item of items) {
    if (!idSet.has(item.id)) continue
    if (item.group_key != null) {
      const existing = groupUnitIndexByKey.get(item.group_key)
      if (existing !== undefined) {
        unitMembers[existing].push(item)
        continue
      }
      groupUnitIndexByKey.set(item.group_key, unitMembers.length)
    }
    unitMembers.push([item])
  }

  const units: SelectionUnit[] = []
  for (const members of unitMembers) {
    const box = unionBoundingBoxes(members.map(boundingBoxForObject))
    // unionBoundingBoxes only returns null for an empty list and every
    // unit has at least one member — pure defensiveness.
    if (box) units.push({ members, box })
  }
  return units
}

/** Rigidly translates one unit's members by `delta`, producing their store
 * patches: box members patch x/y; Line members patch `points` (translated
 * absolute coordinates) plus recomputed descriptive bbox metadata — the
 * exact member-patch shape `buildGroupDragPatches` (U3) established. */
function buildUnitPatches(
  members: CanvasObject[],
  delta: Point,
): Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }> {
  return members.map((member) => {
    if (isLineTool(member.type)) {
      const points = translatePoints(parseLinePoints(member.properties), delta)
      const metadata = points.length > 0 ? computeLineBoundingBox(points) : {}
      return { id: member.id, patch: { points, ...metadata } }
    }
    return { id: member.id, patch: { x: member.x + delta.x, y: member.y + delta.y } }
  })
}

/** The delta that aligns one unit's `box` to the collective extremes for a
 * given `AlignKind` — one translated axis, the other always 0. */
function alignDeltaForUnit(kind: AlignKind, box: BoundingBox, collective: BoundingBox): Point {
  switch (kind) {
    case 'left':
      return { x: collective.x - box.x, y: 0 }
    case 'centerH':
      return { x: collective.x + collective.width / 2 - (box.x + box.width / 2), y: 0 }
    case 'right':
      return { x: collective.x + collective.width - (box.x + box.width), y: 0 }
    case 'top':
      return { x: 0, y: collective.y - box.y }
    case 'middleV':
      return { x: 0, y: collective.y + collective.height / 2 - (box.y + box.height / 2) }
    case 'bottom':
      return { x: 0, y: collective.y + collective.height - (box.y + box.height) }
  }
}

/**
 * Align: translates every unit so its box edge/center matches the
 * selection's COLLECTIVE extreme (`left` → every unit's box.x equals the
 * collective min-x, `centerH` → centers on the collective center, etc.).
 * Units already in place contribute no patches, so a fully-aligned (or
 * single-unit) selection returns `[]` — `updateItemsGeometry` then no-ops
 * without pushing a history entry.
 */
export function buildAlignPatches(
  kind: AlignKind,
  selectedItemIds: CanvasObject['id'][],
  items: CanvasObject[],
): Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }> {
  const units = partitionSelectionUnits(selectedItemIds, items)
  const collective = unionBoundingBoxes(units.map((unit) => unit.box))
  if (!collective) return []

  const patches: Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }> = []
  for (const unit of units) {
    const delta = alignDeltaForUnit(kind, unit.box, collective)
    if (delta.x === 0 && delta.y === 0) continue
    patches.push(...buildUnitPatches(unit.members, delta))
  }
  return patches
}

/**
 * Distribute: sorts the units by box center along `axis` and spaces the
 * middle units' centers evenly between the two extreme centers (which stay
 * put). Needs 3+ BOXES — with fewer there is nothing between the extremes
 * to space, and `[]` is returned (the UI disables the action at the same
 * threshold; this guard makes a stray call harmless).
 */
export function buildDistributePatches(
  axis: DistributeAxis,
  selectedItemIds: CanvasObject['id'][],
  items: CanvasObject[],
): Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }> {
  const units = partitionSelectionUnits(selectedItemIds, items)
  if (units.length < 3) return []

  const centerOf = (box: BoundingBox): number =>
    axis === 'horizontal' ? box.x + box.width / 2 : box.y + box.height / 2

  // Array.prototype.sort is stable, so equal centers keep items order —
  // deterministic output for the same input.
  const ordered = [...units].sort((a, b) => centerOf(a.box) - centerOf(b.box))
  const first = centerOf(ordered[0].box)
  const last = centerOf(ordered[ordered.length - 1].box)
  const step = (last - first) / (ordered.length - 1)

  const patches: Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }> = []
  // The extreme units (index 0 and length-1) are their own targets — only
  // the middle units can move, so iterating them all with a zero-delta skip
  // naturally leaves the extremes untouched.
  ordered.forEach((unit, index) => {
    const target = first + step * index
    const offset = target - centerOf(unit.box)
    if (offset === 0) return
    const delta: Point = axis === 'horizontal' ? { x: offset, y: 0 } : { x: 0, y: offset }
    patches.push(...buildUnitPatches(unit.members, delta))
  })
  return patches
}

/** What the align/distribute UI needs to gate itself (Toolbar section +
 * context-menu entries share this single policy — the plan's "same
 * availability rules" across both surfaces). */
export interface AlignmentAvailability {
  /** How many selected ids matched real items. */
  selectedCount: number
  /** How many alignment UNITS (boxes) the selection partitions into —
   * groups collapse to one box each. */
  boxCount: number
  /** Align actions (and the Toolbar's whole align section) need 2+
   * selected items. */
  canAlign: boolean
  /** Distribute needs 3+ BOXES (2 groups + 1 loose = 3). */
  canDistribute: boolean
}

/** Computes the align/distribute gating for the current selection. */
export function resolveAlignmentAvailability(
  selectedItemIds: CanvasObject['id'][],
  items: CanvasObject[],
): AlignmentAvailability {
  const units = partitionSelectionUnits(selectedItemIds, items)
  const selectedCount = units.reduce((count, unit) => count + unit.members.length, 0)
  return {
    selectedCount,
    boxCount: units.length,
    canAlign: selectedCount >= 2,
    canDistribute: units.length >= 3,
  }
}
