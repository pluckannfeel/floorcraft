/**
 * Custom canvas cursors (canvas-tools follow-up): the native `crosshair`/
 * `text`/`grab` cursors render as thin WHITE glyphs on several platform
 * cursor themes — invisible over the white canvas. Each cursor here is an
 * inline SVG drawn twice: a wide black underlay stroke, then a narrower
 * white overlay stroke, giving a white glyph with a black outline that
 * stays visible on any background (white canvas, dark objects, the gray
 * backdrop). The native keyword rides along as the CSS fallback for
 * browsers that reject data-URI cursors.
 *
 * The hand glyphs reuse lucide's `hand`/`hand-grab` path data (ISC), so
 * the cursor matches the sidebar's Pan button icon exactly.
 */

/** Wraps path markup in the two-pass outline SVG (see module doc). The
 * outline color draws WIDE underneath, the core color narrow on top. */
function outlinedSvg(paths: string, core = 'white', outline = 'black'): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    `<g stroke="${outline}" stroke-width="4">${paths}</g>` +
    `<g stroke="${core}" stroke-width="2">${paths}</g>` +
    '</svg>'
  )
}

/** Builds the full CSS cursor value: data-URI SVG with a hotspot, then the
 * native keyword fallback. `encodeURIComponent` keeps the URI valid in
 * every browser (Firefox rejects raw `<`/`"` in CSS data URIs). */
function svgCursor(
  paths: string,
  hotspotX: number,
  hotspotY: number,
  fallback: string,
  core = 'white',
  outline = 'black',
): string {
  return `url("data:image/svg+xml,${encodeURIComponent(outlinedSvg(paths, core, outline))}") ${hotspotX} ${hotspotY}, ${fallback}`
}

/** Marquee/crop/shape/line drawing: a centered cross, hotspot at its
 * intersection — same geometry as the native crosshair. */
export const CURSOR_CROSSHAIR = svgCursor(
  '<path d="M12 3v18"/><path d="M3 12h18"/>',
  12,
  12,
  'crosshair',
)

/** Text tool: an I-beam (stem + serifs), hotspot mid-stem like the native
 * text cursor. */
export const CURSOR_TEXT = svgCursor(
  '<path d="M12 5v14"/><path d="M9 4h6"/><path d="M9 20h6"/>',
  12,
  12,
  'text',
)

/** The four-way pan glyph — lucide `move`, matching the sidebar's Pan
 * button icon (user feedback: the hand cursors read poorly). */
const MOVE_GLYPH_PATHS =
  '<path d="M12 2v20"/>' +
  '<path d="m15 19-3 3-3-3"/>' +
  '<path d="m19 9 3 3-3 3"/>' +
  '<path d="M2 12h20"/>' +
  '<path d="m5 9-3 3 3 3"/>' +
  '<path d="m9 5 3-3 3 3"/>'

/** Pan available (idle pan mode or Space held): the four-way move arrows,
 * white core / black outline. Native `move` is the matching fallback. */
export const CURSOR_GRAB = svgCursor(MOVE_GLYPH_PATHS, 12, 12, 'move')

/** Pan in flight: the same glyph with the colors INVERTED (black core /
 * white outline) — a subtle pressed-state cue without changing shape. */
export const CURSOR_GRABBING = svgCursor(MOVE_GLYPH_PATHS, 12, 12, 'move', 'black', 'white')
