import { useEffect, useId } from 'react'
import { Button } from '@/components/ui/button'

/**
 * U5 (object-visuals): minimal shared confirm dialog. The codebase has no
 * dialog primitive (components/ui holds only button/card/input/label, and
 * destructive confirms so far used `window.confirm`), but R18's
 * multi-sentence variant-deletion copy outgrows `window.confirm` — so this
 * is the reusable replacement for future destructive actions too.
 *
 * Accessibility contract (doc-review: a11y):
 * - `role="dialog"` + `aria-modal`, labelled by the title and described by
 *   the message (useId-generated ids).
 * - Initial focus lands on CANCEL (`autoFocus`) — the safe action for a
 *   destructive confirm; Enter can never destroy by default.
 * - Escape cancels WITH `stopPropagation` — the same ownership pattern as
 *   UserMenu.tsx's Escape handler: dismissing this dialog must never double
 *   as the canvas's window-level Escape → exit-tool. (React attaches its
 *   listeners at the root, so stopping the native event here prevents it
 *   from ever bubbling to the window handler.)
 * - Clicking the backdrop (and only the backdrop — the target check) cancels,
 *   on `pointerdown` per the UserMenu/ContextMenu outside-dismiss convention.
 *
 * Deliberately minimal: no focus trap / portal machinery — two buttons and
 * a short message don't warrant a dependency, and the fixed full-viewport
 * backdrop already absorbs stray pointer input.
 */
export interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId()
  const messageId = useId()

  // Escape ownership via a CAPTURE-phase window listener, not a React
  // onKeyDown on the dialog subtree (review-pass find): keydown dispatches
  // from document.activeElement, and with no focus trap a click on the
  // dialog's non-focusable text drops focus to <body> — a subtree handler
  // then never fires, so Escape would leak to the canvas's window-level
  // handlers (exit-tool) while the dialog stayed open. Capture-phase +
  // stopPropagation makes the open dialog own Escape no matter where focus
  // sits — the ContextMenu.tsx convention.
  useEffect(() => {
    function handleWindowKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', handleWindowKeyDown, true)
    return () => window.removeEventListener('keydown', handleWindowKeyDown, true)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onPointerDown={(event) => {
        // Backdrop-only: a press inside the panel bubbles here with a
        // deeper target and must not dismiss.
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="w-full max-w-sm rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg"
      >
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>
        <p id={messageId} className="mt-2 text-sm text-muted-foreground">
          {message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          {/* autoFocus: initial focus on the SAFE action (module doc) —
              deliberate for a modal destructive confirm; Enter can never
              destroy by default. */}
          <Button type="button" variant="outline" size="sm" autoFocus onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
