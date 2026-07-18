import type Konva from 'konva'
import type { CanvasObject } from './types'

/** U12: PNG export helpers.
 *
 * Per the plan's Key Technical Decision: export must clear the current
 * selection (detaching both `SelectionTransformer`'s Transformer handles
 * AND `LineAnchorHandles`' anchor Circles, per `CanvasStage.tsx`'s
 * selection-branched rendering — see that file's "which selection UI
 * to show" comment) immediately before `stage.toDataURL()`, so the
 * exported PNG never shows selection/anchor chrome.
 *
 * The tricky part: `clearSelection()` only queues a React state update.
 * `CanvasStage`'s selection branch re-renders asynchronously, and even
 * once React commits, react-konva's own Konva redraw is batched via
 * `Konva.Layer.batchDraw()`, which itself defers to a `requestAnimationFrame`
 * callback (see Konva's `Util._requestAnimFrame`/`Animation` internals) —
 * so a snapshot taken synchronously right after calling `clearSelection()`
 * would very likely still capture the stale, still-attached handles.
 * `afterNextPaint` below waits two animation frames (one for React's commit
 * + the resulting effect that calls `transformer.nodes([])`/unmounts the
 * anchor Circles, a second for Konva's own batched redraw of that change)
 * before invoking the snapshot callback — deliberately NOT a single rAF or
 * a fixed setTimeout, both of which are one frame short of guaranteed-safe
 * for this exact "React state -> effect -> Konva batchDraw" chain.
 */

/** Waits two animation frames before calling `callback` — see this file's
 * doc comment above for why two frames (not one, not a `setTimeout`) is the
 * minimum needed to guarantee a cleared selection has actually been redrawn
 * off the Stage before a snapshot is taken. Exported separately from
 * `exportStageToPng` so it's independently testable without a real
 * `Konva.Stage`. */
export function afterNextPaint(callback: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      callback()
    })
  })
}

/** Creates a temporary `<a download>` element pointing at `dataUrl` and
 * clicks it to trigger a browser download — the standard vanilla-JS
 * data-URL-download recipe (no library needed for this one-shot action). */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

/** Default download filename for `exportStageToPng`. */
export const EXPORT_FILENAME = 'floor-plan.png'

/**
 * Clears the current selection (if any), waits for that clear to actually
 * take effect on the Stage (`afterNextPaint`), then snapshots the Stage to
 * a PNG data URL and triggers a browser download of it.
 *
 * `selectedItemIds`/`clearSelection` are passed in (rather than this
 * function reaching into `canvasStore` itself) so it stays a plain,
 * Konva-adjacent function callable/testable without a mounted store or
 * component tree — same "pure logic, thin Konva plumbing at the call site"
 * split every other canvas/*.ts helper in this codebase already follows
 * (see `LineAnchorHandles.test.tsx`'s doc comment on this convention).
 * U1: the selection is now a set — one `clearSelection()` call detaches
 * whatever chrome any number of selected items had.
 */
export function exportStageToPng(
  stage: Konva.Stage,
  selectedItemIds: ReadonlyArray<CanvasObject['id']>,
  clearSelection: () => void,
  filename: string = EXPORT_FILENAME,
): void {
  if (selectedItemIds.length > 0) {
    clearSelection()
  }
  afterNextPaint(() => {
    const dataUrl = stage.toDataURL()
    downloadDataUrl(dataUrl, filename)
  })
}
