import { describe, expect, it } from 'vitest'
import { CURSOR_CROSSHAIR, CURSOR_GRAB, CURSOR_GRABBING, CURSOR_TEXT } from './cursors'

/** Final-polish round: the canvas cursors are outlined SVGs (white glyph,
 * black underlay) so they stay visible over the white canvas on platform
 * themes whose native cursors render plain white. */
describe('outlined SVG cursors', () => {
  // Pan cursors are the four-way MOVE glyph now (user feedback: the hand
  // read poorly), so their native fallback is 'move'; grabbing inverts the
  // outline colors as a pressed-state cue.
  const CASES: [name: string, value: string, fallback: string][] = [
    ['crosshair', CURSOR_CROSSHAIR, 'crosshair'],
    ['text', CURSOR_TEXT, 'text'],
    ['grab', CURSOR_GRAB, 'move'],
    ['grabbing', CURSOR_GRABBING, 'move'],
  ]

  it.each(CASES)(
    '%s: data-URI SVG with a hotspot and its native keyword fallback',
    (_name, value, fallback) => {
      // url("data:image/svg+xml,...") X Y, <native>
      expect(value).toMatch(/^url\("data:image\/svg\+xml,/)
      expect(value).toMatch(new RegExp(`"\\) \\d+ \\d+, ${fallback}$`))
    },
  )

  it.each([
    ['crosshair', CURSOR_CROSSHAIR],
    ['text', CURSOR_TEXT],
    ['grab', CURSOR_GRAB],
  ] as const)('%s: black outline drawn UNDER the white glyph', (_name, value) => {
    const svg = decodeURIComponent(value.slice('url("data:image/svg+xml,'.length).split('")')[0])
    const blackAt = svg.indexOf('stroke="black"')
    const whiteAt = svg.indexOf('stroke="white"')
    expect(blackAt).toBeGreaterThan(-1)
    expect(whiteAt).toBeGreaterThan(blackAt)
    // The outline only works if the underlay stroke is wider than the glyph.
    expect(svg).toContain('stroke-width="4"')
    expect(svg).toContain('stroke-width="2"')
  })

  it('grabbing: INVERTED colors (white outline under a black core) — the pressed-state cue', () => {
    const svg = decodeURIComponent(
      CURSOR_GRABBING.slice('url("data:image/svg+xml,'.length).split('")')[0],
    )
    const whiteAt = svg.indexOf('stroke="white"')
    const blackAt = svg.indexOf('stroke="black"')
    expect(whiteAt).toBeGreaterThan(-1)
    expect(blackAt).toBeGreaterThan(whiteAt)
  })

  it('grab and grabbing share the four-way move glyph (same paths, different colors)', () => {
    const pathsOf = (value: string) =>
      [...decodeURIComponent(value.slice('url("data:image/svg+xml,'.length).split('")')[0]).matchAll(/<path d="([^"]+)"/g)].map((m) => m[1])
    expect(pathsOf(CURSOR_GRAB)).toEqual(pathsOf(CURSOR_GRABBING))
    expect(pathsOf(CURSOR_GRAB).length).toBeGreaterThan(0)
  })
})
