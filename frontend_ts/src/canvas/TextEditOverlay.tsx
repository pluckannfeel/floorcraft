import { useCallback, useEffect, useRef, useState } from 'react'
import type Konva from 'konva'
import { measureTextBox, parseTextProperties } from './TextTool'
import type { CanvasObject, Point } from './types'

/**
 * U7 (canvas-tools): the DOM text-editing overlay — Konva's official
 * editable-text pattern (an absolutely-positioned textarea over the node,
 * mirroring its font metrics and the stage transform), adapted to this
 * codebase's store-driven coordinates: the Stage's transform here is always
 * exactly `translate(stagePosition) . scale(zoom)` and the text Group sits
 * at the object's stored x/y, so the node's viewport position is derived
 * PURELY from `(containerRect, stagePosition, zoom, object.x/y)` — no live
 * Konva node needed, which both keeps this component jsdom-testable and
 * makes it self-reposition when a wheel-zoom re-renders the page (the plan
 * allows closing on pan/zoom; deriving from the store does one better for
 * zoom, and pans can't start mid-edit — Space types into the textarea, and
 * a middle-mouse press hits the outside-pointerdown commit below).
 *
 * Being a DOM textarea, the existing `isEditableTarget` guard routes
 * Delete/Ctrl+Z/C/V to NATIVE text editing while this is open; Ctrl+S still
 * saves (the save handler blurs the active element first, and blur commits
 * here — so the draft is in the store before the save payload is built).
 *
 * Lifecycle contract (one terminal call, guaranteed by `finishedRef`):
 * - Enter (without Shift) commits; Shift+Enter inserts a newline.
 * - Blur commits.
 * - CAPTURE-PHASE document pointerdown outside the textarea commits — the
 *   plan's ordering hardening: clicking a sidebar/tool button mid-edit
 *   commits the draft into the store BEFORE that click's own handlers run,
 *   so no interaction can observe (or save) the pre-commit state.
 * - Escape cancels, and stops propagation — the overlay is the INNERMOST
 *   consumer in the plan's documented Escape priority order (text overlay →
 *   context menu → crop region → marquee → line-draw), so it must not leak
 *   the key to the others.
 *
 * What commit/cancel DO is the caller's policy (`CanvasEditorPage`):
 * create-mode empty commit aborts the object, re-edit empty commit reverts,
 * unchanged text is a no-op — this component only reports the final draft.
 */

/** Floors for the EDITING box only (never the committed object's mirrored
 * width/height) — see the sizing comment in the component body. */
const MIN_EDITOR_WIDTH_PX = 120
const MIN_EDITOR_HEIGHT_PX = 24

export interface TextEditOverlayProps {
  /** The text object being edited: the live store item (re-edit) or the
   * not-yet-committed draft (create). Position/styling both read from it. */
  object: CanvasObject
  /** `'create'` starts empty and ready to type; `'edit'` selects all for
   * quick replacement (the plan's focus rules). */
  mode: 'create' | 'edit'
  zoom: number
  stagePosition: Point
  /** Resolves the live Stage for its container's viewport rect. Nullable
   * (and null in jsdom tests) — the overlay then positions relative to the
   * viewport origin. */
  getStage: () => Konva.Stage | null
  onCommit: (text: string) => void
  onCancel: () => void
}

export function TextEditOverlay({
  object,
  mode,
  zoom,
  stagePosition,
  getStage,
  onCommit,
  onCancel,
}: TextEditOverlayProps) {
  const styling = parseTextProperties(object.properties)
  const [draft, setDraft] = useState(styling.text)
  // Mirrors `draft` for the document-level capture listener (registered
  // once), which would otherwise close over the first render's value —
  // same ref-mirror convention as PropertyPanel's `draftRef`.
  const draftRef = useRef(draft)
  // One-terminal-call guard: Enter-commit is followed by an unmount blur,
  // Escape-cancel can race the same blur, and an outside pointerdown can
  // precede its own focus change — whichever terminal path runs first wins
  // and every later one is a no-op.
  const finishedRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const finish = useCallback(
    (kind: 'commit' | 'cancel') => {
      if (finishedRef.current) return
      finishedRef.current = true
      if (kind === 'commit') {
        onCommit(draftRef.current)
      } else {
        onCancel()
      }
    },
    [onCommit, onCancel],
  )

  // AUTO-FOCUS on open (both paths); re-edit selects all. Once, on mount —
  // the overlay is remounted per editing session by the caller.
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    if (mode === 'edit') textarea.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The capture-phase outside-interaction commit (see the module doc).
  useEffect(() => {
    function handleDocumentPointerDown(event: PointerEvent) {
      const textarea = textareaRef.current
      if (textarea && event.target instanceof Node && textarea.contains(event.target)) return
      finish('commit')
    }
    document.addEventListener('pointerdown', handleDocumentPointerDown, true)
    return () => document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  }, [finish])

  // Viewport position: container origin + the stage transform applied to
  // the object's stored top-left (see the module doc for why this needs no
  // Konva node).
  const containerRect = getStage()?.container().getBoundingClientRect()
  const left = (containerRect?.left ?? 0) + stagePosition.x + object.x * zoom
  const top = (containerRect?.top ?? 0) + stagePosition.y + object.y * zoom

  // The textarea tracks the draft's would-be rendered box so typing never
  // scrolls/clips inside it — same measurement (and same injectable seam,
  // for jsdom) as every commit path uses for the mirrored width/height.
  const size = measureTextBox(draft, styling)
  // ...but never smaller than a visibly-a-text-field box. An empty draft
  // measures a single space (~4px at the default size), which rendered as
  // a ~12px sliver the user couldn't see, type into with any confidence,
  // or even find — the create flow read as "the text tool does nothing"
  // (it then committed empty on click-away, which correctly aborts, so
  // nothing ever appeared). The floor only affects the EDITING affordance;
  // the committed object's mirrored box still comes from the real
  // measurement in the commit handlers.
  const boxWidth = Math.max(size.width * zoom, MIN_EDITOR_WIDTH_PX)
  const boxHeight = Math.max(size.height * zoom, MIN_EDITOR_HEIGHT_PX)

  return (
    <textarea
      ref={textareaRef}
      aria-label="Edit text"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        draftRef.current = event.target.value
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          // Own the key fully: without preventDefault the newline would
          // land in the textarea before the commit reads the draft.
          event.preventDefault()
          finish('commit')
        } else if (event.key === 'Escape') {
          // Escape ownership: the overlay is the innermost consumer —
          // don't let the key also cancel a marquee/close a menu.
          event.stopPropagation()
          finish('cancel')
        }
      }}
      onBlur={() => finish('commit')}
      style={{
        position: 'fixed',
        left,
        top,
        // A small pad past the measured box so the caret at the line end
        // never clips; `zoom` scales the box the same way the stage scales
        // the node, and the floors above keep an empty draft visible.
        width: boxWidth + 8,
        height: boxHeight + 8,
        // Font metrics mirror ObjectShape's Konva.Text branch exactly
        // (lineHeight 1 is Konva's default), scaled by the stage zoom.
        fontFamily: styling.font_family,
        fontSize: styling.font_size * zoom,
        fontWeight: styling.bold ? 'bold' : 'normal',
        fontStyle: styling.italic ? 'italic' : 'normal',
        lineHeight: 1,
        color: styling.color,
        // The blinking caret defaults to `color` — a white text color would
        // make it (and the insertion point) invisible on the near-white
        // surface below. Pin it to the border's blue so it always reads.
        caretColor: '#2563eb',
        // CSS rotation for rotated text (nice-to-have per the plan) — the
        // Group rotates around its top-left, so the same origin here.
        transform: object.rotation ? `rotate(${object.rotation}deg)` : undefined,
        transformOrigin: 'left top',
        // A near-opaque surface (rather than fully transparent): an empty
        // create-draft has no text to see, so the field needs to read as a
        // field. Light enough that an in-place edit still shows what's
        // underneath.
        background: 'rgba(255, 255, 255, 0.92)',
        border: '1px dashed #2563eb',
        borderRadius: 0,
        margin: 0,
        padding: 0,
        outline: 'none',
        resize: 'none',
        overflow: 'hidden',
        whiteSpace: 'pre',
        zIndex: 40,
      }}
    />
  )
}
