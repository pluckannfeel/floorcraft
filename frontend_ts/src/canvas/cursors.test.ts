import { describe, expect, it } from 'vitest'
import { CURSOR_CROSSHAIR, CURSOR_GRAB, CURSOR_GRABBING, CURSOR_TEXT } from './cursors'

/** Final-polish round: the canvas cursors are outlined SVGs (white glyph,
 * black underlay) so they stay visible over the white canvas on platform
 * themes whose native cursors render plain white. */
describe('outlined SVG cursors', () => {
  const CASES: [name: string, value: string, fallback: string][] = [
    ['crosshair', CURSOR_CROSSHAIR, 'crosshair'],
    ['text', CURSOR_TEXT, 'text'],
    ['grab', CURSOR_GRAB, 'grab'],
    ['grabbing', CURSOR_GRABBING, 'grabbing'],
  ]

  it.each(CASES)(
    '%s: data-URI SVG with a hotspot and its native keyword fallback',
    (_name, value, fallback) => {
      // url("data:image/svg+xml,...") X Y, <native>
      expect(value).toMatch(/^url\("data:image\/svg\+xml,/)
      expect(value).toMatch(new RegExp(`"\\) \\d+ \\d+, ${fallback}$`))
    },
  )

  it.each(CASES)('%s: black outline drawn UNDER the white glyph', (_name, value) => {
    const svg = decodeURIComponent(value.slice('url("data:image/svg+xml,'.length).split('")')[0])
    const blackAt = svg.indexOf('stroke="black"')
    const whiteAt = svg.indexOf('stroke="white"')
    expect(blackAt).toBeGreaterThan(-1)
    expect(whiteAt).toBeGreaterThan(blackAt)
    // The outline only works if the underlay stroke is wider than the glyph.
    expect(svg).toContain('stroke-width="4"')
    expect(svg).toContain('stroke-width="2"')
  })
})
