import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Fast, styled hover tooltip (object-visuals follow-up, user feedback: the
 * native `title` attribute is slow — ~1s OS delay — and unstyled). A short
 * 120ms intent delay, then a dark fixed-position bubble above the wrapped
 * element.
 *
 * Design notes:
 * - The wrapper is `display: contents`, so it never disturbs the layout of
 *   grid/flex parents (the tool grid and catalog tile rows) — React's
 *   synthetic pointerenter/leave still fire through it.
 * - The bubble is `position: fixed` and coordinates come from the target's
 *   live bounding rect, so it can never be clipped by the sidebar's
 *   scrollable tile rows (`overflow-x-auto` would clip any absolutely-
 *   positioned child bubble).
 * - `pointerdown` hides immediately: a press means the user is acting, and
 *   a tooltip lingering over a drag preview reads as jank.
 * - Purely presentational (`role="tooltip"`, aria-hidden): every wrapped
 *   control already carries its accessible name via `aria-label` — this
 *   never replaces it.
 */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const wrapperRef = useRef<HTMLSpanElement | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  const show = (event: React.PointerEvent) => {
    // Final review pass: never arm while a button is held — during a
    // catalog drag the pointer sweeps tiles beneath the (pointer-events-
    // none) preview, and popping THEIR tooltips over the drag is the exact
    // jank this component exists to avoid.
    if (event.buttons !== 0) return
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      // The wrapper has no box (display: contents) — measure its first
      // element child (the wrapped control).
      const target = wrapperRef.current?.firstElementChild as HTMLElement | null
      const rect = target?.getBoundingClientRect()
      if (rect) setPosition({ x: rect.left + rect.width / 2, y: rect.top - 6 })
    }, 120)
  }

  const hide = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    setPosition(null)
  }

  return (
    <span
      ref={wrapperRef}
      className="contents"
      onPointerEnter={show}
      onPointerLeave={hide}
      // CAPTURE phase: the wrapped tiles stop pointerdown propagation
      // (the sidebar's pointer-ownership contract), which would starve a
      // bubble-phase hide — capture runs before the child's handler.
      onPointerDownCapture={hide}
    >
      {children}
      {position != null && (
        <span
          role="tooltip"
          aria-hidden="true"
          className="pointer-events-none fixed z-60 -translate-x-1/2 -translate-y-full rounded-md bg-foreground px-2 py-1 text-[11px] font-medium whitespace-nowrap text-background shadow-md"
          style={{ left: position.x, top: position.y }}
        >
          {label}
        </span>
      )}
    </span>
  )
}
