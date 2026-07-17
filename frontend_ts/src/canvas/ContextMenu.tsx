import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { resolveAlignmentAvailability } from './alignment'
import type { AlignKind, DistributeAxis } from './alignment'
import type { CanvasObject, Point } from './types'

/**
 * U5 (canvas-tools plan): the canvas's right-click context menu.
 *
 * A custom shadcn-STYLED component (Tailwind classes matching shadcn's
 * dropdown/context-menu recipe — popover tokens, item paddings, the
 * disabled `pointer-events-none opacity-50` treatment), NOT a new
 * dependency: the plan's Key Technical Decision is an absolutely-positioned
 * DOM menu opened from Konva `contextmenu` events with `preventDefault`,
 * closing on click-away and Escape.
 *
 * Selection policy lives elsewhere: by the time this renders,
 * `CanvasStage`'s right-click selection rule has already made the store's
 * selection match what the user visually targeted, and `CanvasEditorPage`
 * has computed each entry's availability (`resolveContextMenuAvailability`
 * below). Every entry ALWAYS renders; unavailable ones are disabled, never
 * hidden — the menu's shape stays stable so users learn it.
 *
 * Escape ownership (plan's documented priority order, innermost first):
 * text overlay → context menu → crop region → marquee-in-progress →
 * line-draw finish. The menu sits above crop/marquee, but an open menu
 * means no marquee is active anyway (a marquee is a left-drag gesture; the
 * menu opens on right-click and closes on any pointerdown), so this
 * listener just closes the menu without any cross-listener arbitration.
 * Keyboard operability beyond Escape-close (arrow navigation, Shift+F10)
 * is explicitly out of v1 scope — keyboard users have the Ctrl+C/X/V/G
 * shortcuts directly.
 */

/** Which context-menu entries are actionable for the current selection/
 * clipboard state. Copy and Cut always agree (both need a selection), but
 * are kept separate so the menu never has to encode that coupling. */
export interface ContextMenuAvailability {
  canCopy: boolean
  canCut: boolean
  canPaste: boolean
  canGroup: boolean
  canUngroup: boolean
  /** U6: align entries need 2+ selected items. */
  canAlign: boolean
  /** U6: distribute entries need 3+ BOXES — a group collapses to one box
   * (2 groups + 1 loose item = 3), per `resolveAlignmentAvailability`. */
  canDistribute: boolean
}

/**
 * Pure availability policy (U5), unit-tested without mounting the menu:
 *
 * - Copy/Cut need a selection that matches at least one item.
 * - Paste needs clipboard content (the caller passes
 *   `hasClipboardContent()` — module state isn't reactive, so it's sampled
 *   when the menu opens/re-renders).
 * - Group needs 2+ selected items that aren't ALREADY exactly one group:
 *   a selection whose members all share one non-null key would just
 *   re-stamp itself (mixed keys or any ungrouped member make Group
 *   meaningful again — it merges everything into one flat group, R9).
 * - Ungroup needs at least one grouped member in the selection (mirrors
 *   `ungroupSelection`'s own no-op guard).
 * - Align/Distribute (U6) share the Toolbar section's policy via
 *   `resolveAlignmentAvailability` — the plan's "same availability rules"
 *   across both surfaces: align needs 2+ selected items, distribute needs
 *   3+ boxes (groups collapse to one box each).
 */
// Non-component export colocated with the menu it gates — same convention as
// `CanvasStage.tsx`'s pure helpers.
// eslint-disable-next-line react-refresh/only-export-components
export function resolveContextMenuAvailability(
  selectedItemIds: CanvasObject['id'][],
  items: CanvasObject[],
  clipboardHasContent: boolean,
): ContextMenuAvailability {
  const idSet = new Set(selectedItemIds)
  const selected = items.filter((item) => idSet.has(item.id))
  const hasSelection = selected.length > 0

  const keys = new Set(selected.map((item) => item.group_key ?? null))
  const isExactlyOneGroup = selected.length >= 2 && keys.size === 1 && !keys.has(null)

  const alignment = resolveAlignmentAvailability(selectedItemIds, items)

  return {
    canCopy: hasSelection,
    canCut: hasSelection,
    canPaste: clipboardHasContent,
    canGroup: selected.length >= 2 && !isExactlyOneGroup,
    canUngroup: selected.some((item) => item.group_key != null),
    canAlign: alignment.canAlign,
    canDistribute: alignment.canDistribute,
  }
}

/** U6: the align entries, FLAT (the plan explicitly allows flat over a
 * submenu — the menu's shape stays a single learnable list). Labels match
 * the Toolbar's aria-labels so both surfaces speak one language. */
const ALIGN_MENU_ENTRIES: { kind: AlignKind; label: string }[] = [
  { kind: 'left', label: 'Align left' },
  { kind: 'centerH', label: 'Align horizontal center' },
  { kind: 'right', label: 'Align right' },
  { kind: 'top', label: 'Align top' },
  { kind: 'middleV', label: 'Align vertical middle' },
  { kind: 'bottom', label: 'Align bottom' },
]

/** U6: the distribute entries (flat, like the align entries). */
const DISTRIBUTE_MENU_ENTRIES: { axis: DistributeAxis; label: string }[] = [
  { axis: 'horizontal', label: 'Distribute horizontally' },
  { axis: 'vertical', label: 'Distribute vertically' },
]

interface ContextMenuProps {
  /** Where to place the menu's top-left corner, in CLIENT (viewport)
   * coordinates — the `contextmenu` event's clientX/clientY. Rendered with
   * `position: fixed`, so no positioned ancestor is required. */
  position: Point
  availability: ContextMenuAvailability
  onCopy: () => void
  onCut: () => void
  onPaste: () => void
  onGroup: () => void
  onUngroup: () => void
  /** U6: align/distribute the selection — same thin delegation as the
   * Toolbar's `onAlignSelection`/`onDistributeSelection` (both surfaces
   * dispatch into the same page-level handlers). */
  onAlign: (kind: AlignKind) => void
  onDistribute: (axis: DistributeAxis) => void
  /** Close request: click-away or Escape. Action entries close themselves
   * by calling their handler AND this. */
  onClose: () => void
}

interface MenuItemProps {
  label: string
  shortcut?: string
  disabled: boolean
  onSelect: () => void
}

/** One menu entry — shadcn menu-item styling, rendered as a real disabled-
 * capable `<button role="menuitem">` so availability is both visual
 * (opacity) and behavioral (unclickable) with no extra guards. */
function MenuItem({ label, shortcut, disabled, onSelect }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full cursor-default items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {label}
      {shortcut && (
        <span className="ml-auto pl-6 text-xs tracking-widest text-muted-foreground">
          {shortcut}
        </span>
      )}
    </button>
  )
}

export function ContextMenu({
  position,
  availability,
  onCopy,
  onCut,
  onPaste,
  onGroup,
  onUngroup,
  onAlign,
  onDistribute,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close on click-away and Escape. Window-level like the editor's other
  // key/pointer listeners; pointerdown (not click) so the menu is already
  // gone by the time the press becomes a canvas gesture. The right-press
  // that OPENED the menu can't self-close it: its pointerdown fired before
  // the menu mounted, and `contextmenu` (which mounts it) fires after.
  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const menu = menuRef.current
      if (menu && event.target instanceof Node && menu.contains(event.target)) return
      onClose()
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const select = (handler: () => void) => () => {
    handler()
    onClose()
  }

  // Code-review fix: clamp the menu into the viewport — a fixed-position
  // menu anchored at a bottom/right-edge click would otherwise render its
  // lower entries (align/distribute) off-screen and unreachable. Measured
  // after first paint; max-height + scroll below is the belt-and-braces
  // for very short windows.
  const [clamped, setClamped] = useState(position)
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) {
      setClamped(position)
      return
    }
    const margin = 8
    const rect = menu.getBoundingClientRect()
    setClamped({
      x: Math.max(margin, Math.min(position.x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(position.y, window.innerHeight - rect.height - margin)),
    })
  }, [position])

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Canvas context menu"
      style={{ left: clamped.x, top: clamped.y, maxHeight: 'calc(100vh - 16px)' }}
      className="fixed z-50 min-w-40 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      // A right-click ON the menu itself must not re-open the native menu
      // dance mid-interaction; keep it inert like shadcn's menus do.
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuItem label="Copy" shortcut="Ctrl+C" disabled={!availability.canCopy} onSelect={select(onCopy)} />
      <MenuItem label="Cut" shortcut="Ctrl+X" disabled={!availability.canCut} onSelect={select(onCut)} />
      <MenuItem label="Paste" shortcut="Ctrl+V" disabled={!availability.canPaste} onSelect={select(onPaste)} />
      <div role="separator" aria-orientation="horizontal" className="-mx-1 my-1 h-px bg-border" />
      <MenuItem label="Group" shortcut="Ctrl+G" disabled={!availability.canGroup} onSelect={select(onGroup)} />
      <MenuItem
        label="Ungroup"
        shortcut="Ctrl+Shift+G"
        disabled={!availability.canUngroup}
        onSelect={select(onUngroup)}
      />
      <div role="separator" aria-orientation="horizontal" className="-mx-1 my-1 h-px bg-border" />
      {/* U6: align/distribute, flat entries under the same availability
          rules as the Toolbar section (one policy —
          `resolveAlignmentAvailability`). Like every other entry they
          always render and merely disable when unavailable. */}
      {ALIGN_MENU_ENTRIES.map(({ kind, label }) => (
        <MenuItem
          key={kind}
          label={label}
          disabled={!availability.canAlign}
          onSelect={select(() => onAlign(kind))}
        />
      ))}
      {DISTRIBUTE_MENU_ENTRIES.map(({ axis, label }) => (
        <MenuItem
          key={axis}
          label={label}
          disabled={!availability.canDistribute}
          onSelect={select(() => onDistribute(axis))}
        />
      ))}
    </div>
  )
}
