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
 * U6 EXTENDED this module as planned: the full defensive parser
 * (`parseVariantReference`), the one frontend derivation of the file
 * endpoint URL (`variantFileUrl`), the `image` arm of `BoxVisual`, and the
 * aspect-fit drop math (`aspectFitDimensions`). Everything stays pure —
 * no fetching, no registry, no store access — so the whole decision
 * surface remains testable in jsdom (imageRegistry.ts owns the load
 * lifecycle; the undo-redo learning's rule that image-load state NEVER
 * touches the zustand store starts with keeping it out of this module).
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

/**
 * U6: the FULL defensive parser over the reference key — the
 * `parseTextProperties` convention (validate shape, never trust persisted
 * JSON): returns the variant's server id exactly when the stored value is
 * a positive integer NUMBER, and `null` for everything else — missing key,
 * null/undefined properties, non-number values (including numeric STRINGS:
 * only the drop path ever writes this key and it always stamps a number;
 * a string here means corruption, and corrupt references must fail closed
 * to the symbol, R16/AE1), NaN/Infinity, zero/negative, and fractional
 * values (server PKs are positive integers).
 *
 * Returning `null` — not throwing, not "best effort" coercion — is what
 * makes a soft-deleted/foreign/garbage reference degrade to the tinted
 * default symbol without ever touching the store (plan: "no serializer-
 * side validation of variant references — rendering fails closed").
 */
export function parseVariantReference(
  properties: CanvasObject['properties'] | null | undefined,
): number | null {
  if (!hasVariantReference(properties)) return null
  const value = properties?.[VISUAL_VARIANT_ID_KEY]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * The ONE frontend derivation of a variant's authenticated file endpoint —
 * the exact convention the backend's `variants.variant_file_url` builds and
 * `useVariants`' `file_url` rows carry (U3's serving contract:
 * `/api/object-variants/<id>/file/`). A placed object stores only the ID
 * (opaque reference in `properties`), so the render path must re-derive the
 * URL here; deriving it in ObjectShape AND the registry independently would
 * be the two-derivations-of-one-truth failure mode this module exists to
 * prevent (see module doc). Absolute `/api/...` path (not apiClient-relative)
 * because it feeds `<img src>`/Konva image loading, not axios — same-origin,
 * so session cookies flow and export tainting is impossible (plan KTD).
 */
export function variantFileUrl(variantId: number): string {
  return `/api/object-variants/${variantId}/file/`
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
 * symbol map without a cast). U6: the `image` arm for placed variants — it
 * carries the file endpoint `url` for the registry hook AND the narrowed
 * `type`, because the image branch still needs the type's tinted default
 * symbol as its loading/failed PLACEHOLDER (R16: plans always read as
 * plans, on screen and in exports).
 */
export type BoxVisual =
  | { kind: 'symbol'; type: CatalogType }
  | { kind: 'image'; url: string; type: CatalogType }
  | { kind: 'plain' }

/**
 * Decides what ObjectShape's generic BOX branch draws (lines and text have
 * already branched away before this is consulted; their rendering is
 * untouched by object-visuals). Pure and exported so the branch decision is
 * testable in jsdom without mounting Konva — the repo's "pure logic, thin
 * Konva plumbing" convention.
 *
 * - Catalog types (R1/R2): the tinted top-down symbol.
 * - Catalog types carrying a VALID variant reference (U6, R8/R10): the
 *   uploaded image, via the file endpoint URL derived from the reference.
 * - Shapes: the pre-U4 plain colored Rect + label, untouched.
 *
 * Fail-closed routing (AE1 render half, R16): the reference key's PRESENCE
 * (`hasVariantReference`) routes toward the variant pipeline — never
 * properties emptiness, because legacy rows carry arbitrary property keys
 * (AE3) — but only a reference the defensive parser VALIDATES resolves to
 * the image arm. A malformed/garbage reference falls back to the tinted
 * default symbol here at the decision level (a URL built from garbage
 * would just 404 into the R16 placeholder anyway; failing closed earlier
 * skips the doomed fetch entirely). Soft-deleted/foreign ids parse fine —
 * they fail at FETCH time instead, where the registry degrades them to the
 * same placeholder (the server deliberately keeps serving soft-deleted
 * files, R11, so those keep rendering).
 */
export function resolveBoxVisual(object: Pick<CanvasObject, 'type' | 'properties'>): BoxVisual {
  if (!isCatalogType(object.type)) return { kind: 'plain' }
  const variantId = parseVariantReference(object.properties)
  if (variantId != null) {
    return { kind: 'image', url: variantFileUrl(variantId), type: object.type }
  }
  return { kind: 'symbol', type: object.type }
}

/**
 * U6 aspect-fit drop math (R8, plan KTD "Aspect-fit drops"): maps a
 * variant's pipeline-recorded NATURAL dimensions onto drop dimensions whose
 * LONGEST side is `longest` (the 40px catalog default), preserving aspect
 * ratio — a 3:1 sofa photo lands as a 3:1 box, never squashed into a
 * square. Computed SYNCHRONOUSLY from the drag payload's recorded dims so
 * image-load completion never needs to touch the store (undo-redo
 * learning: async load state must never write items).
 *
 * Degenerate clamp (deepening + doc-review): zero/negative/absent/NaN/
 * non-finite natural dimensions clamp to `longest`×`longest` (40×40 by
 * default) — NaN geometry must NEVER enter the store, its undo history, or
 * the save payload. The recorded dims are server-validated (U2 clamps
 * viewBox-derived values), but this is the last line of defense and the
 * drag payload is still just data. Outputs are rounded, and each side is
 * floored at 1 so an extreme aspect ratio (4000×1) can't round a dimension
 * down to 0 (degenerate geometry the Transformer/marquee math would choke
 * on).
 */
export function aspectFitDimensions(
  natural: { width?: unknown; height?: unknown } | null | undefined,
  longest: number = 40,
): { width: number; height: number } {
  const w = natural?.width
  const h = natural?.height
  const valid =
    typeof w === 'number' &&
    typeof h === 'number' &&
    Number.isFinite(w) &&
    Number.isFinite(h) &&
    w > 0 &&
    h > 0
  if (!valid) return { width: longest, height: longest }
  const scale = longest / Math.max(w, h)
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
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
