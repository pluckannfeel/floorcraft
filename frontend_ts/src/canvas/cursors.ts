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

/** Wraps path markup in the two-pass outline SVG (see module doc). */
function outlinedSvg(paths: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    `<g stroke="black" stroke-width="4">${paths}</g>` +
    `<g stroke="white" stroke-width="2">${paths}</g>` +
    '</svg>'
  )
}

/** Builds the full CSS cursor value: data-URI SVG with a hotspot, then the
 * native keyword fallback. `encodeURIComponent` keeps the URI valid in
 * every browser (Firefox rejects raw `<`/`"` in CSS data URIs). */
function svgCursor(paths: string, hotspotX: number, hotspotY: number, fallback: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(outlinedSvg(paths))}") ${hotspotX} ${hotspotY}, ${fallback}`
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

/** Pan available (idle pan mode or Space held): lucide `hand`. */
export const CURSOR_GRAB = svgCursor(
  '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/>' +
    '<path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>' +
    '<path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/>' +
    '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  12,
  12,
  'grab',
)

/** Pan in flight: lucide `hand-grab` (the closed fist). */
export const CURSOR_GRABBING = svgCursor(
  '<path d="M18 11.5V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1.4"/>' +
    '<path d="M14 10V8a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>' +
    '<path d="M10 9.9V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v5"/>' +
    '<path d="M6 14a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/>' +
    '<path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8 2 2 0 1 1 4 0"/>',
  12,
  12,
  'grabbing',
)
