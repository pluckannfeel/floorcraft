import Konva from 'konva'
import type { TextType } from './types'

/**
 * U7 (canvas-tools): pure helpers for the first-class `text` object type —
 * the same colocated-helpers convention as `LineTool.tsx`/`ShapeTool.tsx`
 * (type narrowing, per-type constants, and the Konva-free math the
 * components delegate to), plus the one deliberately impure member: text
 * measurement, behind an injectable seam (see `measureTextBox` below).
 *
 * Properties shape (mirrors the backend contract in
 * `fm_generator/serializers.py`'s `_validate_text_properties`):
 * `{text, font_family, font_size, bold, italic, color}`. `text` is the
 * object's SUBSTANCE (content commits are undo-tracked, like a Line's
 * points); the styling keys are cosmetic (untracked, R15). The object's
 * top-level width/height MIRROR the auto-sized text box — recomputed via
 * `measureTextBox` on every content/styling commit — so every consumer
 * that reasons over boxes (marquee hit-testing, align/distribute, group
 * drag clamping, clipboard bbox origins) works on text objects with zero
 * special-casing.
 */

/** Narrows `ActiveTool`/`ObjectType` to the text type — same pattern as
 * `isLineTool`/`isShapeTool`. */
export function isTextType(tool: string): tool is TextType {
  return tool === 'text'
}

/**
 * The curated font preset list (plan: ~6 system-safe families; no webfont
 * ships in v1, so no `document.fonts.load()` hook is needed). Rendered as
 * the PropertyPanel's font-family select options; `DEFAULT_TEXT_STYLING`
 * uses the first entry.
 */
export const TEXT_FONT_FAMILIES = [
  'Arial',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Trebuchet MS',
] as const

/** Whole-object styling for a text object (everything in `properties`
 * except the content itself). */
export interface TextStyling {
  font_family: string
  font_size: number
  bold: boolean
  italic: boolean
  color: string
}

/** A text object's full parsed `properties` (content + styling). */
export interface TextProperties extends TextStyling {
  text: string
}

export const DEFAULT_TEXT_STYLING: TextStyling = {
  font_family: TEXT_FONT_FAMILIES[0],
  font_size: 16,
  bold: false,
  italic: false,
  color: '#111827',
}

/** Floor for the transformer's fontSize fold (`computeTransformCommit`) and
 * the PropertyPanel's size input — a 0/negative font size would make the
 * node unmeasurable and the object invisible/unrecoverable. */
export const MIN_TEXT_FONT_SIZE = 4

/**
 * Safely reads a text object's `properties` JSON (typed
 * `Record<string, unknown>`, no DB-level shape enforcement — the same
 * defensiveness as `parseLinePoints`), defaulting any missing/malformed
 * key from `DEFAULT_TEXT_STYLING`.
 */
export function parseTextProperties(properties: Record<string, unknown> | undefined): TextProperties {
  return {
    text: typeof properties?.text === 'string' ? properties.text : '',
    font_family:
      typeof properties?.font_family === 'string' && properties.font_family !== ''
        ? properties.font_family
        : DEFAULT_TEXT_STYLING.font_family,
    font_size:
      typeof properties?.font_size === 'number' && Number.isFinite(properties.font_size) && properties.font_size > 0
        ? properties.font_size
        : DEFAULT_TEXT_STYLING.font_size,
    bold: properties?.bold === true,
    italic: properties?.italic === true,
    color:
      typeof properties?.color === 'string' && properties.color !== ''
        ? properties.color
        : DEFAULT_TEXT_STYLING.color,
  }
}

/** Composes Konva's per-node `fontStyle` string from the stored boolean
 * pair — Konva's documented composition values ('italic bold', not
 * 'bold italic'). */
export function fontStyleFor(styling: Pick<TextStyling, 'bold' | 'italic'>): string {
  if (styling.bold && styling.italic) return 'italic bold'
  if (styling.bold) return 'bold'
  if (styling.italic) return 'italic'
  return 'normal'
}

export interface TextBoxSize {
  width: number
  height: number
}

/** The measurement function's shape — see `measureTextBox`. */
export type TextMeasurer = (text: string, styling: TextStyling) => TextBoxSize

/**
 * The REAL measurer: a detached (never staged) `Konva.Text` configured
 * exactly like `ObjectShape`'s render branch — no `width`, so it
 * auto-sizes — whose `width()`/`height()` are the mirrored box. Konva
 * measures through a private canvas context, so this needs a working
 * `<canvas>` (fine in the browser; impossible in jsdom — hence the seam).
 * An empty draft measures as a single space so the box always spans at
 * least one caret-sized line.
 */
function konvaMeasureTextBox(text: string, styling: TextStyling): TextBoxSize {
  const node = new Konva.Text({
    text: text.length > 0 ? text : ' ',
    fontFamily: styling.font_family,
    fontSize: styling.font_size,
    fontStyle: fontStyleFor(styling),
  })
  const size = { width: node.width(), height: node.height() }
  node.destroy()
  return size
}

let measurer: TextMeasurer = konvaMeasureTextBox

/**
 * Measures the auto-sized box a text object renders as — the single
 * mirrored-width/height source every commit path uses (overlay content
 * commits, PropertyPanel styling commits, the transformer's fontSize fold,
 * and the create-draft's initial box).
 *
 * Injectable: jsdom has no canvas implementation, so tests stub the
 * underlying measurer via `setTextMeasurer` instead of letting Konva's
 * real measurement run (which would throw on jsdom's null 2D context).
 */
export function measureTextBox(text: string, styling: TextStyling): TextBoxSize {
  return measurer(text, styling)
}

/** Test seam for `measureTextBox` (see above). Returns the PREVIOUS
 * measurer so a test can restore it. */
export function setTextMeasurer(next: TextMeasurer): TextMeasurer {
  const previous = measurer
  measurer = next
  return previous
}
