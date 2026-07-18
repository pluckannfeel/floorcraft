/**
 * U4 (object-visuals): the visual-decision key module — the single source of
 * truth for "how does this canvas object render".
 *
 * Why this module exists NOW (and not in U6, which adds the full defensive
 * variant parser + aspect-fit math): ObjectShape's branch selection already
 * needs to know whether an object carries a variant reference, and U6's
 * parser will need the exact same key. Hardcoding the key string in
 * ObjectShape today and "formalizing" it in U6 later would be two
 * derivations of one truth — the exact failure mode the pan-tool learning
 * documents (docs/solutions/ui-bugs/pan-tool-stale-imperative-stage-
 * draggable-restore-2026-07-18.md: the Stage `draggable` prop and its
 * imperative restores each derived `spaceHeld || panTool` independently,
 * one went stale, and panning died). One exported constant + one exported
 * predicate, consumed by every reader, makes divergence impossible by
 * construction.
 *
 * U6 EXTENDS this module (full parser: id extraction/validation, foreign/
 * malformed fallback, aspect-fit helper). Keep U4's surface minimal.
 */
import { CATALOG_TYPES } from './types'
import type { CanvasObject, CatalogType } from './types'

/**
 * The `properties` key holding a placed variant's server id (opaque
 * reference — no FK from Objects, same precedent as `group_key`).
 * snake_case because `properties` round-trips verbatim through the backend
 * JSON field next to existing snake_case keys (`font_family`, `points`);
 * feature-prefixed (`visual_`) so it cannot collide with user-authored
 * property rows like a plain "variant" or "id" typed into the PropertyPanel.
 */
export const VISUAL_VARIANT_ID_KEY = 'visual_variant_id'

/**
 * Presence predicate ONLY: true exactly when the reference key exists on
 * `properties` — deliberately says nothing about the value being a valid
 * variant id. Validity (numeric, owned, still serving) is U6's defensive
 * parser's job; branch selection must key on PRESENCE, never on properties
 * emptiness, because legacy rows carry arbitrary keys (plan AE3) and a
 * malformed reference still must route toward the variant pipeline so it
 * can fall back to the placeholder symbol (R16), not silently pretend it
 * was never a variant.
 */
export function hasVariantReference(
  properties: CanvasObject['properties'] | null | undefined,
): boolean {
  return (
    properties != null && Object.prototype.hasOwnProperty.call(properties, VISUAL_VARIANT_ID_KEY)
  )
}

/** Narrows the 14-value `ObjectType` enum to the 7 sidebar catalog types —
 * the only types with authored symbols (symbols.ts) and, later, uploaded
 * variants. Same guard shape as `isLineTool`/`isTextType`. */
export function isCatalogType(type: string): type is CatalogType {
  return (CATALOG_TYPES as readonly string[]).includes(type)
}

/**
 * The generic box branch's visual, as a discriminated union so the 'symbol'
 * arm carries the narrowed `CatalogType` (consumers index the exhaustive
 * symbol map without a cast). U6 adds an
 * `{ kind: 'image', ... }` arm here for placed variants.
 */
export type BoxVisual = { kind: 'symbol'; type: CatalogType } | { kind: 'plain' }

/**
 * Decides what ObjectShape's generic BOX branch draws (lines and text have
 * already branched away before this is consulted; their rendering is
 * untouched by object-visuals). Pure and exported so the branch decision is
 * testable in jsdom without mounting Konva — the repo's "pure logic, thin
 * Konva plumbing" convention.
 *
 * - Catalog types (R1/R2): the tinted top-down symbol.
 * - Shapes: the pre-U4 plain colored Rect + label, untouched.
 *
 * U6 SEAM — placed-variant image branch: when `hasVariantReference(
 * object.properties)` is true, U6 resolves the reference through its
 * defensive parser and returns an `image` visual; until then a
 * variant-carrying object DELIBERATELY still renders its type's tinted
 * symbol (which is also the R16 loading/failed placeholder it will keep
 * degrading to). The decision keys on the reference key's PRESENCE via
 * `hasVariantReference`, never on properties emptiness — legacy rows carry
 * arbitrary property keys and must keep routing to the symbol branch (AE3).
 */
export function resolveBoxVisual(object: Pick<CanvasObject, 'type' | 'properties'>): BoxVisual {
  if (!isCatalogType(object.type)) return { kind: 'plain' }
  return { kind: 'symbol', type: object.type }
}

/**
 * Label rule R17 for symbol (and, in U6, image) objects: a user-given
 * `name` still renders; the redundant type label does not. Returns null
 * for empty/whitespace-only names — the pre-U4 `object.name || object.type`
 * fallback painted "tables"/"chairs" across every symbol, defeating the
 * point of drawing recognizable geometry. Plain shapes keep their old
 * fallback (R17 is scoped to symbol/image visuals).
 */
export function symbolLabelText(name: string): string | null {
  return name.trim() === '' ? null : name
}

/**
 * Hit-area contract (U4, deepening: architecture): the fill of the
 * full-size, ALWAYS-MOUNTED backing Rect behind every symbol.
 *
 * `Konva.Path` hit regions are painted-geometry-only, so without a backing
 * rect an unselected sparse symbol (a door's thin leaf + arc band, say) is
 * clickable only on its painted pixels — silently breaking click-select,
 * group-drag grabs, and pan-mode click-to-select across most of the
 * object's box. The backing Rect must therefore be HIT-SOLID while staying
 * invisible: an explicit zero-alpha rgba fill keeps Konva's hit graph
 * painting the whole rect (an `undefined`/absent fill would make the hit
 * graph skip it entirely). Exported as a constant so the contract is
 * assertable at the pure level (jsdom can't mount Konva to click it).
 */
export const BACKING_RECT_FILL = 'rgba(0,0,0,0)'
