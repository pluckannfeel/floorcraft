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
    viewBox: VIEW_BOX_100,
    paths: [
      // Full-bleed wall band: outer contour clockwise, inner counter-
      // clockwise → nonzero winding leaves the room interior open.
      'M0 0 H100 V100 H0 Z M10 10 V90 H90 V10 Z',
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
      // Dresser/cabinet carcass: filled band with an open interior.
      'M4 8 H96 V92 H4 Z M12 16 V84 H88 V16 Z',
      // Center divider splitting the interior into two compartments.
      'M47 16 H53 V84 H47 Z',
      // A knob per compartment.
      'M30 46 A4 4 0 1 1 30 54 A4 4 0 1 1 30 46 Z',
      'M70 46 A4 4 0 1 1 70 54 A4 4 0 1 1 70 46 Z',
    ],
  },
  appliances: {
    viewBox: VIEW_BOX_100,
    paths: [
      // Counter-unit body band.
      'M4 4 H96 V96 H4 Z M12 12 V88 H88 V12 Z',
      // Four ring burners (outer disc clockwise + inner hole counter-
      // clockwise each) — the cooktop plan symbol.
      'M34 21 A13 13 0 1 1 34 47 A13 13 0 1 1 34 21 Z M34 27 A7 7 0 1 0 34 41 A7 7 0 1 0 34 27 Z',
      'M66 21 A13 13 0 1 1 66 47 A13 13 0 1 1 66 21 Z M66 27 A7 7 0 1 0 66 41 A7 7 0 1 0 66 27 Z',
      'M34 53 A13 13 0 1 1 34 79 A13 13 0 1 1 34 53 Z M34 59 A7 7 0 1 0 34 73 A7 7 0 1 0 34 59 Z',
      'M66 53 A13 13 0 1 1 66 79 A13 13 0 1 1 66 53 Z M66 59 A7 7 0 1 0 66 73 A7 7 0 1 0 66 59 Z',
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
