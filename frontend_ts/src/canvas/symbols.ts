/**
 * U4 (object-visuals): the hand-authored top-down architectural symbol
 * library for the 7 catalog types (R1/R2), plus the pure viewBox→box scale
 * helper ObjectShape uses to stretch a symbol over an object's stored
 * width/height.
 *
 * FILLED-GEOMETRY CONTRACT (deepening: architecture): every symbol is
 * filled geometry ONLY — no stroke styling anywhere in this module, and
 * consumers must never put `stroke` props on the symbol `Path` nodes.
 * Anything that reads as an outline (the door's swing arc, the table's
 * surface outline, ring burners) is authored as a filled band/annulus.
 * Why: both `symbolScale` below and the SelectionTransformer apply
 * NON-UNIFORM scale (resize folds into width/height), and a stroked
 * sub-path distorts anisotropically after the first non-uniform resize —
 * a 2px arc stroke becomes 2px tall but 6px wide. Fills scale cleanly.
 * symbols.test.ts pins this contract structurally.
 *
 * Rendering stays FULLY DECLARATIVE: tint is applied via the `fill` prop
 * (`colorForType`, R3) — never `node.cache()` + filters, the
 * imperative-divergence hazard the pan-tool learning documents
 * (docs/solutions/ui-bugs/pan-tool-stale-imperative-stage-draggable-
 * restore-2026-07-18.md).
 *
 * Multi-part symbols are a LIST of path-data strings — one Konva `Path`
 * (or inline-SVG `<path>`, for Sidebar thumbnails: R5 reuses this exact
 * data) per entry. An individual entry may still contain multiple
 * subpaths when a fill HOLE is needed (outer contour clockwise + inner
 * contour counter-clockwise → nonzero winding punches the hole); holes
 * can't be split across separate Path nodes.
 *
 * Artwork vs mechanism (plan, Open Questions): the map/viewBox/scale/tint
 * MECHANISM is the planned surface; the path data itself is authored art,
 * iterable freely without touching any consumer.
 */
import type { CatalogType } from './types'

/** A symbol's native coordinate space. All current symbols are authored on
 * a 100×100 canvas for hand-editability, but nothing may assume that —
 * consumers must always map through `symbolScale`. */
export interface SymbolViewBox {
  width: number
  height: number
}

export interface SymbolDefinition {
  viewBox: SymbolViewBox
  /** Filled-geometry-only SVG path data (M/L/H/V/A/Z…), one Konva `Path`
   * per entry. NO styling of any kind lives here — tint is the consumer's
   * `fill`, and stroke is forbidden (see module doc). */
  paths: readonly string[]
}

const VIEW_BOX_100: SymbolViewBox = { width: 100, height: 100 }

/**
 * Exhaustive over `CatalogType` — the same compile-time completeness
 * convention as ObjectShape's `TYPE_COLORS`: adding a catalog type without
 * authoring its symbol is a compile error, never a runtime blank.
 *
 * Top-down (plan-view) reading of each symbol:
 * - outlines: plain filled wall band (deliberately simple — outlines get
 *   stretched as whole-room regions, so anything ornate would distort).
 * - tables: surface outline band + center pedestal disc.
 * - doors: leaf bar standing open + filled quarter-annulus swing arc
 *   (the conventional architectural door symbol, arcs as fills).
 * - chairs: backrest band + solid seat + armrest bars.
 * - furnitures: dresser/cabinet carcass band + divider + two knobs.
 * - appliances: counter unit band + four ring burners (cooktop).
 * - lighting: ceiling-fixture ring + eight radiating light wedges.
 */
export const SYMBOLS: Record<CatalogType, SymbolDefinition> = {
  outlines: {
    // Rectangular viewBox (user feedback: an outline reads as a ROOM, not
    // a square) — this entry now only feeds the sidebar thumbnails; the
    // CANVAS renders outlines via `outlineStrokeRect` below so the wall
    // thickness stays constant under resize.
    viewBox: { width: 150, height: 100 },
    paths: [
      // Full-bleed wall band: outer contour clockwise, inner counter-
      // clockwise → nonzero winding leaves the room interior open.
      'M0 0 H150 V100 H0 Z M12 12 V88 H138 V12 Z',
    ],
  },
  tables: {
    viewBox: VIEW_BOX_100,
    paths: [
      // Table-top surface outline as a filled band (inset from the box so
      // it reads as furniture, not a room outline).
      'M6 6 H94 V94 H6 Z M14 14 V86 H86 V14 Z',
      // Center pedestal disc.
      'M50 37 A13 13 0 1 1 50 63 A13 13 0 1 1 50 37 Z',
    ],
  },
  doors: {
    viewBox: VIEW_BOX_100,
    paths: [
      // Door leaf standing open: a bar along the left edge, hinge at the
      // bottom-left corner.
      'M4 4 H16 V92 H4 Z',
      // Swing arc as a FILLED quarter-annulus (outer radius 88, inner 82)
      // sweeping from the leaf tip to the closed position along the bottom
      // edge — the outlined arc of the classic symbol, authored as a fill
      // per the module contract.
      'M10 4 A88 88 0 0 1 98 92 L92 92 A82 82 0 0 0 10 10 Z',
    ],
  },
  chairs: {
    viewBox: VIEW_BOX_100,
    paths: [
      // Backrest band across the top (wider than the seat).
      'M10 4 H90 V18 H10 Z',
      // Solid seat.
      'M18 24 H82 V90 H18 Z',
      // Armrest bars.
      'M8 24 H16 V74 H8 Z',
      'M84 24 H92 V74 H84 Z',
    ],
  },
  furnitures: {
    viewBox: VIEW_BOX_100,
    paths: [
      // Sofa in PLAN VIEW (user feedback: the old dresser drawing read as
      // a front elevation): back band along the bottom edge…
      'M4 70 H96 V96 H4 Z',
      // …armrests down each side…
      'M4 18 H18 V70 H4 Z',
      'M82 18 H96 V70 H82 Z',
      // …and two seat cushions with a visible split.
      'M22 22 H48 V66 H22 Z',
      'M52 22 H78 V66 H52 Z',
    ],
  },
  appliances: {
    viewBox: VIEW_BOX_100,
    paths: [
      // Cooktop in PLAN VIEW (user feedback: redrawn to read clearly
      // top-down): thin body outline…
      'M4 4 H96 V96 H4 Z M10 10 V90 H90 V10 Z',
      // …four LARGE ring burners filling the surface…
      'M32 14 A16 16 0 0 1 32 46 A16 16 0 0 1 32 14 Z M32 22 A8 8 0 0 0 32 38 A8 8 0 0 0 32 22 Z',
      'M68 14 A16 16 0 0 1 68 46 A16 16 0 0 1 68 14 Z M68 22 A8 8 0 0 0 68 38 A8 8 0 0 0 68 22 Z',
      'M32 50 A16 16 0 0 1 32 82 A16 16 0 0 1 32 50 Z M32 58 A8 8 0 0 0 32 74 A8 8 0 0 0 32 58 Z',
      'M68 50 A16 16 0 0 1 68 82 A16 16 0 0 1 68 50 Z M68 58 A8 8 0 0 0 68 74 A8 8 0 0 0 68 58 Z',
      // …and the control strip along the front edge.
      'M14 86 H86 V92 H14 Z',
    ],
  },
  lighting: {
    viewBox: VIEW_BOX_100,
    paths: [
      // Ceiling-fixture ring (annulus: outer clockwise + inner hole
      // counter-clockwise).
      'M50 32 A18 18 0 1 1 50 68 A18 18 0 1 1 50 32 Z M50 40 A10 10 0 1 0 50 60 A10 10 0 1 0 50 40 Z',
      // Eight radiating light wedges: four cardinal…
      'M45 2 L55 2 L50 24 Z',
      'M45 98 L55 98 L50 76 Z',
      'M2 45 L2 55 L24 50 Z',
      'M98 45 L98 55 L76 50 Z',
      // …and four diagonal.
      'M12 19 L19 12 L32 32 Z',
      'M88 19 L81 12 L68 32 Z',
      'M12 81 L19 88 L32 68 Z',
      'M88 81 L81 88 L68 68 Z',
    ],
  },
}

/**
 * PURE viewBox→box scale mapping: the factors that stretch a symbol's
 * native coordinate space over an object's stored width/height.
 * NON-UNIFORM by design — SelectionTransformer folds resize scale into
 * width/height, so a stretched table must stretch its symbol with it
 * (which the filled-geometry contract above makes safe). Rotation is
 * deliberately NOT this helper's business: the ObjectShape Group owns
 * rotation (and position), and the symbol Paths inherit it by sitting at
 * group-local (0,0).
 *
 * Pure and exported per the repo's testing convention: jsdom can't mount
 * Konva, so the math ObjectShape feeds into `scaleX`/`scaleY` props is
 * asserted standalone in symbols.test.ts.
 */
export function symbolScale(
  viewBox: SymbolViewBox,
  width: number,
  height: number,
): { scaleX: number; scaleY: number } {
  return { scaleX: width / viewBox.width, scaleY: height / viewBox.height }
}

/** The outline type's wall-band thickness in MODEL units (user feedback:
 * resizing an outline must EXPAND the room, never thicken the walls — so
 * the thickness is a constant, not something a scale can touch; it zooms
 * with the stage like every other model-space dimension). */
export const OUTLINE_EDGE_THICKNESS = 6

/**
 * The outline's render recipe: ONE stroked Rect whose stroke is drawn with
 * Konva's `strokeScaleEnabled(false)` — the stroke width ignores EVERY
 * scale on the node's ancestor chain, which is exactly what makes the wall
 * thickness constant DURING a live Transformer gesture (user feedback:
 * the band-based first cut only corrected thickness at commit, because
 * bands derive from store dims that update at transformend while the live
 * gesture scales the whole Group). The costs of opting out of scaling are
 * repaid declaratively:
 * - Stage ZOOM would also stop scaling the walls, so `strokeWidth` is
 *   `edge * zoom` — zoom is React state, ObjectShape re-renders on it, and
 *   during a transform gesture zoom never changes, so the stroke stays
 *   put mid-gesture and still zooms like model-space geometry otherwise.
 * - The stroke centers on the rect path, so the rect is inset by edge/2:
 *   the stroke's outer boundary lands exactly on the object's box.
 * The thickness clamps to half the smaller dimension so degenerate boxes
 * collapse toward a solid bar instead of a negative interior. Pure and
 * tested standalone (the no-Konva-in-jsdom convention).
 */
export function outlineStrokeRect(
  width: number,
  height: number,
  zoom: number,
  thickness: number = OUTLINE_EDGE_THICKNESS,
): { x: number; y: number; width: number; height: number; strokeWidth: number } {
  const edge = Math.max(0, Math.min(thickness, width / 2, height / 2))
  return {
    x: edge / 2,
    y: edge / 2,
    width: Math.max(0, width - edge),
    height: Math.max(0, height - edge),
    strokeWidth: edge * zoom,
  }
}


/**
 * Built-in symbol PRESETS (user feedback): some types ship more than one
 * stock look — a round table, an AC unit. A preset is an alternate
 * filled-geometry drawing for an existing catalog type; placed objects
 * reference it via `properties.visual_preset` (visuals.ts) exactly like
 * uploaded variants ride `visual_variant_id` — an opaque, session-stable
 * string the renderer resolves fail-closed (unknown ids fall back to the
 * type's default symbol, so old plans and typo'd data always render).
 */
export interface SymbolPreset {
  id: string
  label: string
  viewBox: SymbolViewBox
  paths: string[]
  /** Optional creation size in MODEL units — presets whose real-world
   * shape isn't square (a slim split-AC wall unit) drop at their natural
   * proportions instead of the type's square default. */
  defaultSize?: { width: number; height: number }
}

export const EXTRA_SYMBOL_PRESETS: Partial<Record<CatalogType, SymbolPreset[]>> = {
  tables: [
    {
      id: 'round',
      label: 'Round table',
      viewBox: VIEW_BOX_100,
      paths: [
        // Round table top: outer circle clockwise, inner counter-clockwise
        // (the same winding-hole convention as every other symbol).
        'M50 4 A46 46 0 0 1 50 96 A46 46 0 0 1 50 4 Z M50 14 A36 36 0 0 0 50 86 A36 36 0 0 0 50 14 Z',
        // Center pedestal disc.
        'M50 42 A8 8 0 0 1 50 58 A8 8 0 0 1 50 42 Z',
      ],
    },
  ],
  appliances: [
    {
      id: 'ac',
      label: 'Cassette AC',
      viewBox: VIEW_BOX_100,
      paths: [
        // Ceiling-cassette AC in PLAN VIEW (user feedback: redrawn — the
        // corner-slat first cut didn't read as AC): body band…
        'M4 4 H96 V96 H4 Z M12 12 V88 H88 V12 Z',
        // …one LONG vent slot inset along each of the four edges (the
        // signature cassette look)…
        'M24 16 H76 V22 H24 Z',
        'M24 78 H76 V84 H24 Z',
        'M16 24 H22 V76 H16 Z',
        'M78 24 H84 V76 H78 Z',
        // …and the center fan intake (donut).
        'M50 36 A14 14 0 0 1 50 64 A14 14 0 0 1 50 36 Z M50 44 A6 6 0 0 0 50 56 A6 6 0 0 0 50 44 Z',
      ],
    },
    {
      id: 'split',
      label: 'Split AC',
      // Wall-mounted split indoor unit in PLAN VIEW: a slim wide body
      // against the wall with a long louver slot along the room-facing
      // edge. Authored on a wide viewBox and dropped at matching slim
      // proportions (defaultSize below).
      viewBox: { width: 100, height: 34 },
      paths: [
        // Body band.
        'M2 2 H98 V32 H2 Z M8 8 V26 H92 V8 Z',
        // Louver slot along the front (room-facing) edge.
        'M14 17 H86 V23 H14 Z',
      ],
      defaultSize: { width: 80, height: 24 },
    },
    {
      id: 'window',
      label: 'Window AC',
      // Window unit in PLAN VIEW: boxy body with the center fan intake
      // and a vertical vent bar down each side.
      viewBox: { width: 100, height: 80 },
      paths: [
        // Body band.
        'M4 4 H96 V76 H4 Z M12 12 V68 H88 V12 Z',
        // Side vent bars.
        'M18 16 H24 V64 H18 Z',
        'M76 16 H82 V64 H76 Z',
        // Center fan intake (donut).
        'M50 24 A16 16 0 0 1 50 56 A16 16 0 0 1 50 24 Z M50 32 A8 8 0 0 0 50 48 A8 8 0 0 0 50 32 Z',
      ],
      defaultSize: { width: 48, height: 40 },
    },
  ],
}

/**
 * Resolves the drawing for a type + optional preset id — the ONE lookup
 * both the canvas glyph and the sidebar tiles use. Unknown/absent preset
 * ids fall back to the type's default symbol (fail-closed, like every
 * other visual reference).
 */
/** The full preset row (or null) — the lookup `symbolDefinitionFor` and
 * the page's per-preset default drop size both resolve through. */
export function symbolPresetFor(
  type: CatalogType,
  presetId: string | null | undefined,
): SymbolPreset | null {
  if (!presetId) return null
  return (EXTRA_SYMBOL_PRESETS[type] ?? []).find((entry) => entry.id === presetId) ?? null
}

export function symbolDefinitionFor(
  type: CatalogType,
  presetId: string | null | undefined,
): SymbolDefinition {
  const preset = symbolPresetFor(type, presetId)
  if (preset) return { viewBox: preset.viewBox, paths: preset.paths }
  return SYMBOLS[type]
}
