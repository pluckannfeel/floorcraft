import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ContextMenu, resolveContextMenuAvailability } from './ContextMenu'
import type { ContextMenuAvailability } from './ContextMenu'
import type { CanvasObject } from './types'

/**
 * Like `PropertyPanel`, `ContextMenu` renders plain DOM (no Konva Stage), so
 * it mounts directly under jsdom. The pure availability policy is tested
 * standalone; the component tests cover rendering, the shadcn disabled
 * treatment (disabled entries render but never fire), and the close
 * behaviors (click-away, Escape, action-then-close).
 */

function makeObject(overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    id: 'item-1',
    floor_plan: 1,
    type: 'chairs',
    name: '',
    x: 0,
    y: 0,
    width: 40,
    height: 40,
    rotation: 0,
    z_index: 0,
    properties: {},
    ...overrides,
  }
}

const allEnabled: ContextMenuAvailability = {
  canCopy: true,
  canCut: true,
  canPaste: true,
  canGroup: true,
  canUngroup: true,
}

const allDisabled: ContextMenuAvailability = {
  canCopy: false,
  canCut: false,
  canPaste: false,
  canGroup: false,
  canUngroup: false,
}

function renderMenu(
  availability: ContextMenuAvailability,
  handlers: Partial<Record<'onCopy' | 'onCut' | 'onPaste' | 'onGroup' | 'onUngroup' | 'onClose', () => void>> = {},
) {
  const noop = () => {}
  return render(
    <ContextMenu
      position={{ x: 120, y: 80 }}
      availability={availability}
      onCopy={handlers.onCopy ?? noop}
      onCut={handlers.onCut ?? noop}
      onPaste={handlers.onPaste ?? noop}
      onGroup={handlers.onGroup ?? noop}
      onUngroup={handlers.onUngroup ?? noop}
      onClose={handlers.onClose ?? noop}
    />,
  )
}

describe('resolveContextMenuAvailability (U5)', () => {
  it('disables everything on empty canvas with an empty clipboard (Paste-only menu shape, nothing actionable)', () => {
    expect(resolveContextMenuAvailability([], [makeObject()], false)).toEqual(allDisabled)
  })

  it('empty selection + clipboard content → Paste is the only enabled entry', () => {
    expect(resolveContextMenuAvailability([], [makeObject()], true)).toEqual({
      ...allDisabled,
      canPaste: true,
    })
  })

  it('a single ungrouped selection enables Copy/Cut only', () => {
    expect(
      resolveContextMenuAvailability(['item-1'], [makeObject()], false),
    ).toEqual({ ...allDisabled, canCopy: true, canCut: true })
  })

  it('selection ids matching no items count as no selection', () => {
    expect(resolveContextMenuAvailability(['ghost'], [makeObject()], false)).toEqual(allDisabled)
  })

  it('2+ ungrouped selected enable Group', () => {
    const items = [makeObject({ id: 'a' }), makeObject({ id: 'b' })]
    const availability = resolveContextMenuAvailability(['a', 'b'], items, false)
    expect(availability.canGroup).toBe(true)
    expect(availability.canUngroup).toBe(false)
  })

  it('a selection that is already exactly one group disables Group but enables Ungroup', () => {
    const items = [
      makeObject({ id: 'a', group_key: 'group-1' }),
      makeObject({ id: 'b', group_key: 'group-1' }),
    ]
    const availability = resolveContextMenuAvailability(['a', 'b'], items, false)
    expect(availability.canGroup).toBe(false)
    expect(availability.canUngroup).toBe(true)
  })

  it('mixed keys (a group plus a loose object) enable BOTH Group (merge) and Ungroup (dissolve)', () => {
    const items = [
      makeObject({ id: 'a', group_key: 'group-1' }),
      makeObject({ id: 'b', group_key: 'group-1' }),
      makeObject({ id: 'c' }),
    ]
    const availability = resolveContextMenuAvailability(['a', 'b', 'c'], items, false)
    expect(availability.canGroup).toBe(true)
    expect(availability.canUngroup).toBe(true)
  })

  it('a lone grouped member (member-mode) enables Ungroup but not Group', () => {
    const items = [
      makeObject({ id: 'a', group_key: 'group-1' }),
      makeObject({ id: 'b', group_key: 'group-1' }),
    ]
    const availability = resolveContextMenuAvailability(['a'], items, false)
    expect(availability.canGroup).toBe(false)
    expect(availability.canUngroup).toBe(true)
  })
})

describe('ContextMenu (U5)', () => {
  it('always renders all five entries (plus a separator), positioned at the given viewport point', () => {
    renderMenu(allDisabled)

    const menu = screen.getByRole('menu', { name: 'Canvas context menu' })
    expect(menu).toHaveStyle({ left: '120px', top: '80px' })
    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('Copy'),
      expect.stringContaining('Cut'),
      expect.stringContaining('Paste'),
      expect.stringContaining('Group'),
      expect.stringContaining('Ungroup'),
    ])
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('unavailable entries render disabled (shadcn treatment), available ones enabled', () => {
    renderMenu({ ...allDisabled, canCopy: true, canCut: true })

    expect(screen.getByRole('menuitem', { name: /Copy/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /Cut/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /Paste/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /^Group/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /Ungroup/ })).toBeDisabled()
  })

  it('clicking an enabled entry fires its handler AND closes the menu', async () => {
    const onCopy = vi.fn()
    const onClose = vi.fn()
    renderMenu(allEnabled, { onCopy, onClose })
    const user = userEvent.setup()

    await user.click(screen.getByRole('menuitem', { name: /Copy/ }))

    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('each entry routes to its own handler', async () => {
    const handlers = {
      onCopy: vi.fn(),
      onCut: vi.fn(),
      onPaste: vi.fn(),
      onGroup: vi.fn(),
      onUngroup: vi.fn(),
      onClose: vi.fn(),
    }
    renderMenu(allEnabled, handlers)
    const user = userEvent.setup()

    await user.click(screen.getByRole('menuitem', { name: /Paste/ }))
    await user.click(screen.getByRole('menuitem', { name: /Ungroup/ }))

    expect(handlers.onPaste).toHaveBeenCalledTimes(1)
    expect(handlers.onUngroup).toHaveBeenCalledTimes(1)
    expect(handlers.onCopy).not.toHaveBeenCalled()
    expect(handlers.onCut).not.toHaveBeenCalled()
    expect(handlers.onGroup).not.toHaveBeenCalled()
  })

  it('a disabled Paste never fires (empty-clipboard error path)', () => {
    const onPaste = vi.fn()
    const onClose = vi.fn()
    renderMenu({ ...allEnabled, canPaste: false }, { onPaste, onClose })

    // fireEvent (not userEvent): the disabled treatment includes
    // pointer-events-none, so a user can't even hover it — a programmatic
    // click on the disabled button is the strongest claim jsdom can check.
    fireEvent.click(screen.getByRole('menuitem', { name: /Paste/ }))

    expect(onPaste).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    renderMenu(allEnabled, { onClose })

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on pointerdown outside the menu (click-away)', () => {
    const onClose = vi.fn()
    renderMenu(allEnabled, { onClose })

    fireEvent.pointerDown(document.body)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a pointerdown INSIDE the menu does not close it (the click completes the action instead)', () => {
    const onClose = vi.fn()
    renderMenu(allEnabled, { onClose })

    fireEvent.pointerDown(screen.getByRole('menuitem', { name: /Copy/ }))

    expect(onClose).not.toHaveBeenCalled()
  })
})
