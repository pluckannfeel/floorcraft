import { describe, expect, it } from 'vitest'
import { SYMBOLS, symbolScale } from './symbols'
import {
  BACKING_RECT_FILL,
  VISUAL_VARIANT_ID_KEY,
  hasVariantReference,
  isCatalogType,
  resolveBoxVisual,
  symbolLabelText,
} from './visuals'
import { CATALOG_TYPES, SHAPE_TYPES } from './types'
import type { CatalogType } from './types'

/**
 * U4 (object-visuals): the symbol library + the visuals key module, tested
 * together at the pure level — jsdom can't mount Konva, so everything
 * ObjectShape feeds into its `Path`/`Rect` props (path data, scale factors,
 * branch decision, label rule, hit-fill) is asserted standalone here (the
 * repo's "pure logic, thin Konva plumbing" convention). visuals.ts is
 * colocated in this suite because U4 ships the two modules as one surface;
 * U6 grows the parser and its own coverage.
 */

describe('symbol library (U4: R1–R5)', () => {
  it('covers all 7 catalog types with non-empty path data (exhaustive map)', () => {
    // The Record<CatalogType, …> annotation already makes a MISSING key a
    // compile error (the TYPE_COLORS convention); this pins the runtime
    // shape too — no extra keys, no empty artwork.
    expect(Object.keys(SYMBOLS).sort()).toEqual([...CATALOG_TYPES].sort())
    for (const type of CATALOG_TYPES) {
      expect(SYMBOLS[type].paths.length, `${type} has artwork`).toBeGreaterThan(0)
    }
  })

  it('every viewBox is positive (scale math depends on it)', () => {
    for (const type of CATALOG_TYPES) {
      const { viewBox } = SYMBOLS[type]
      expect(viewBox.width, `${type} viewBox.width`).toBeGreaterThan(0)
      expect(viewBox.height, `${type} viewBox.height`).toBeGreaterThan(0)
    }
  })

  it('FILLED-GEOMETRY CONTRACT: no symbol definition carries stroke styling', () => {
    // Non-uniform resize (Transformer folds scale into width/height)
    // distorts stroked sub-paths anisotropically — so definitions are bare
    // geometry: exactly {viewBox, paths}, and each path string is raw SVG
    // path data (commands + coordinates), with no styling vocabulary of any
    // kind smuggled in. Outlined-looking parts (door swing arc, table
    // outline) must be authored as filled bands instead.
    for (const type of CATALOG_TYPES) {
      const definition = SYMBOLS[type]
      expect(Object.keys(definition).sort(), `${type} definition shape`).toEqual([
        'paths',
        'viewBox',
      ])
      for (const data of definition.paths) {
        expect(data.trim(), `${type} path data non-empty`).not.toBe('')
        expect(data, `${type} carries no stroke styling`).not.toMatch(/stroke/i)
        // Path commands + numbers + separators only — nothing that could
        // encode style (no attributes, no CSS, no markup).
        expect(data, `${type} is bare path geometry`).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9\s,.+-]+$/)
      }
    }
  })
})

describe('symbolScale (U4: pure viewBox→object-box mapping)', () => {
  it.each([
    // [viewBox, width, height, scaleX, scaleY]
    [{ width: 100, height: 100 }, 100, 100, 1, 1], // identity
    [{ width: 100, height: 100 }, 40, 40, 0.4, 0.4], // the default drop size
    [{ width: 100, height: 100 }, 200, 50, 2, 0.5], // NON-UNIFORM stretch
    [{ width: 100, height: 100 }, 10, 1000, 0.1, 10], // extreme non-uniform
    [{ width: 50, height: 200 }, 100, 100, 2, 0.5], // non-square viewBox
  ])('maps viewBox %o onto %d×%d → scale (%f, %f)', (viewBox, width, height, scaleX, scaleY) => {
    expect(symbolScale(viewBox, width, height)).toEqual({ scaleX, scaleY })
  })

  it('returns ONLY scale factors — rotation/position stay Group-owned', () => {
    // The ObjectShape Group carries x/y/rotation; symbol Paths sit at
    // group-local (0,0) and inherit them. The helper must never grow
    // rotation output that a consumer could double-apply.
    expect(Object.keys(symbolScale({ width: 100, height: 100 }, 80, 40)).sort()).toEqual([
      'scaleX',
      'scaleY',
    ])
  })

  it('works against the real library entries', () => {
    expect(symbolScale(SYMBOLS.tables.viewBox, 80, 40)).toEqual({ scaleX: 0.8, scaleY: 0.4 })
    expect(symbolScale(SYMBOLS.doors.viewBox, 40, 40)).toEqual({ scaleX: 0.4, scaleY: 0.4 })
  })
})

describe('visuals key module (U4: variant reference + branch decision)', () => {
  it('the reference key is the snake_case, feature-prefixed constant', () => {
    // Pinned verbatim: this string lands inside persisted `properties`
    // JSON — changing it would orphan every placed variant reference.
    expect(VISUAL_VARIANT_ID_KEY).toBe('visual_variant_id')
  })

  describe('hasVariantReference (presence ONLY — validity is U6\'s parser)', () => {
    it('is true exactly when the key is present, whatever the value', () => {
      expect(hasVariantReference({ [VISUAL_VARIANT_ID_KEY]: 7 })).toBe(true)
      // Malformed values still count as "references" so they can degrade
      // to the placeholder symbol (R16) instead of silently reclassifying.
      expect(hasVariantReference({ [VISUAL_VARIANT_ID_KEY]: null })).toBe(true)
      expect(hasVariantReference({ [VISUAL_VARIANT_ID_KEY]: 'garbage' })).toBe(true)
    })

    it('is false for absent key, arbitrary legacy keys, and null/undefined properties', () => {
      expect(hasVariantReference({})).toBe(false)
      // AE3: legacy rows carry arbitrary keys — presence of OTHER keys must
      // never read as a variant reference (never key on emptiness).
      expect(hasVariantReference({ material: 'oak', legacy: true })).toBe(false)
      expect(hasVariantReference(null)).toBe(false)
      expect(hasVariantReference(undefined)).toBe(false)
    })
  })

  describe('resolveBoxVisual (ObjectShape branch selection, pure)', () => {
    it.each([...CATALOG_TYPES])('%s renders the symbol visual, narrowed to its type', (type) => {
      expect(resolveBoxVisual({ type, properties: {} })).toEqual({ kind: 'symbol', type })
    })

    it('AE3: a legacy object with arbitrary properties keys still routes to the symbol branch', () => {
      expect(
        resolveBoxVisual({ type: 'tables', properties: { material: 'oak', seats: 6 } }),
      ).toEqual({ kind: 'symbol', type: 'tables' })
    })

    it('U6 SEAM: a variant reference still renders the SYMBOL for now (image branch lands in U6)', () => {
      expect(
        resolveBoxVisual({ type: 'chairs', properties: { [VISUAL_VARIANT_ID_KEY]: 12 } }),
      ).toEqual({ kind: 'symbol', type: 'chairs' })
    })

    it.each([...SHAPE_TYPES])('%s keeps the pre-U4 plain colored box', (type) => {
      expect(resolveBoxVisual({ type, properties: {} })).toEqual({ kind: 'plain' })
    })
  })

  describe('isCatalogType', () => {
    it('accepts exactly the 7 catalog types', () => {
      for (const type of CATALOG_TYPES) expect(isCatalogType(type)).toBe(true)
      for (const type of ['shape_rectangle', 'line_straight', 'text', 'sofa', '']) {
        expect(isCatalogType(type)).toBe(false)
      }
    })
  })

  describe('symbolLabelText (label rule R17)', () => {
    it('renders a user-given name verbatim', () => {
      expect(symbolLabelText('Reception desk')).toBe('Reception desk')
    })

    it('renders NOTHING for empty/whitespace names — the type fallback is gone', () => {
      // Pre-U4 the box branch painted `name || type` ("tables", "chairs")
      // over every object; symbols make that label redundant (R17).
      expect(symbolLabelText('')).toBeNull()
      expect(symbolLabelText('   ')).toBeNull()
    })
  })

  describe('backing-rect hit contract', () => {
    it('the backing fill is present but fully transparent (hit-solid, invisible)', () => {
      // Konva Path hit regions are painted-geometry-only, so the ALWAYS-
      // MOUNTED backing Rect owns the whole width×height hit box — an
      // unselected sparse symbol must be clickable ANYWHERE in its box
      // (click-select / group-drag / pan-mode click-to-select). That only
      // works if the fill EXISTS (Konva's hit graph skips no-fill shapes),
      // and only looks right if its alpha is zero.
      expect(BACKING_RECT_FILL).toBeDefined()
      expect(BACKING_RECT_FILL).not.toBe('transparent')
      expect(BACKING_RECT_FILL).toMatch(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/)
    })
  })
})

/** Compile-time exhaustiveness companion (the TYPE_COLORS convention): if a
 * catalog type is ever added, this assignment fails to compile until the
 * symbol map gains its entry — the runtime key assertion above then pins
 * the reverse (no extra keys). */
const _exhaustive: Record<CatalogType, unknown> = SYMBOLS
void _exhaustive
