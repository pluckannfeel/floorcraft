import Konva from 'konva'

/**
 * Canvas gesture-in-flight tracking (final review pass): the Enter-finalize
 * shortcut (deselect + pan + save) must NO-OP while a canvas gesture is
 * mid-flight — firing it mid-transform detaches the Transformer before the
 * scale folds into the store (the object stays visually scaled while the
 * store and the save hold pre-transform dims), mid-marquee it flips the
 * tool to pan and the release then plants a selection in pan mode, and
 * mid-drag it force-ends the drag against pre-drag store state.
 *
 * Konva's own `isDragging()` covers every Konva drag (stage pans, object
 * drags) with no wiring; marquee, transformer, and crop-region gestures are
 * counted explicitly by their owners (CanvasStage's marquee/crop begin/end
 * paths, SelectionTransformer's transformstart/transformend). A COUNTER —
 * not a boolean — so overlapping gestures (however unlikely) can't
 * under-report.
 *
 * Module-level like the image registry: gesture state is render-plumbing,
 * never store state (no undo/dirty interaction possible by construction).
 */

let activeGestures = 0

export function beginCanvasGesture(): void {
  activeGestures += 1
}

export function endCanvasGesture(): void {
  activeGestures = Math.max(0, activeGestures - 1)
}

/** Test seam / defensive reset (mirrors resetImageRegistry's role). */
export function resetCanvasGestures(): void {
  activeGestures = 0
}

export function isCanvasGestureInFlight(): boolean {
  return activeGestures > 0 || Konva.isDragging()
}
