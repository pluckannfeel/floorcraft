import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TextEditOverlay } from './TextEditOverlay'
import { setTextMeasurer } from './TextTool'
import type { TextMeasurer } from './TextTool'
import type { CanvasObject } from './types'

/**
 * U7: the DOM text-editing overlay. Unlike the Konva components, this is a
 * plain textarea — it mounts directly under jsdom (`getStage` returns null
 * here, which the overlay treats as a zero-origin container). The one
 * jsdom-incompatible dependency, Konva-backed text measurement, is stubbed
 * through `TextTool.ts`'s injectable measurer seam.
 */

function makeTextObject(overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    id: 'text-1',
    floor_plan: 1,
    type: 'text',
    name: '',
    x: 100,
    y: 80,
    width: 60,
    height: 16,
    rotation: 0,
    z_index: 0,
    properties: {
      text: 'Meeting Room',
      font_family: 'Arial',
      font_size: 16,
      bold: false,
      italic: false,
      color: '#111827',
    },
    ...overrides,
  }
}

interface RenderOverlayArgs {
  object?: CanvasObject
  mode?: 'create' | 'edit'
  onCommit?: (text: string) => void
  onCancel?: () => void
}

function renderOverlay({
  object = makeTextObject(),
  mode = 'edit',
  onCommit = () => {},
  onCancel = () => {},
}: RenderOverlayArgs = {}) {
  return render(
    <TextEditOverlay
      object={object}
      mode={mode}
      zoom={1}
      stagePosition={{ x: 0, y: 0 }}
      getStage={() => null}
      onCommit={onCommit}
      onCancel={onCancel}
    />,
  )
}

let restoreMeasurer: TextMeasurer

beforeEach(() => {
  restoreMeasurer = setTextMeasurer((text) => ({
    width: Math.max(1, text.length) * 8,
    height: 16,
  }))
})

afterEach(() => {
  setTextMeasurer(restoreMeasurer)
})

describe('TextEditOverlay', () => {
  it('auto-focuses on open; create mode starts empty and ready to type', () => {
    renderOverlay({
      object: makeTextObject({ properties: { text: '' } }),
      mode: 'create',
    })

    const textarea = screen.getByLabelText('Edit text')
    expect(textarea).toHaveFocus()
    expect(textarea).toHaveValue('')
  })

  it('re-edit mode opens with the existing text fully selected (quick replace)', () => {
    renderOverlay({ mode: 'edit' })

    const textarea = screen.getByLabelText('Edit text') as HTMLTextAreaElement
    expect(textarea).toHaveFocus()
    expect(textarea).toHaveValue('Meeting Room')
    expect(textarea.selectionStart).toBe(0)
    expect(textarea.selectionEnd).toBe('Meeting Room'.length)
  })

  it('Enter (without Shift) commits the typed draft', async () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    renderOverlay({
      object: makeTextObject({ properties: { text: '' } }),
      mode: 'create',
      onCommit,
      onCancel,
    })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Edit text'), 'Kitchen{Enter}')

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Kitchen')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Shift+Enter inserts a newline instead of committing', async () => {
    const onCommit = vi.fn()
    renderOverlay({
      object: makeTextObject({ properties: { text: '' } }),
      mode: 'create',
      onCommit,
    })
    const user = userEvent.setup()

    await user.type(
      screen.getByLabelText('Edit text'),
      'Line 1{Shift>}{Enter}{/Shift}Line 2',
    )

    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Edit text')).toHaveValue('Line 1\nLine 2')
  })

  it('Escape cancels (never commits) and stops propagation so outer Escape consumers never see it', async () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const windowEscapeListener = vi.fn()
    window.addEventListener('keydown', windowEscapeListener)
    renderOverlay({ mode: 'edit', onCommit, onCancel })
    const user = userEvent.setup()

    await user.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    // Escape ownership (plan's priority order): the overlay is the
    // innermost consumer — the key must not bubble to window-level
    // listeners (marquee cancel, context-menu close).
    expect(windowEscapeListener).not.toHaveBeenCalled()
    window.removeEventListener('keydown', windowEscapeListener)
  })

  it('blur commits the draft', async () => {
    const onCommit = vi.fn()
    renderOverlay({
      object: makeTextObject({ properties: { text: '' } }),
      mode: 'create',
      onCommit,
    })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Edit text'), 'Updated label')
    ;(document.activeElement as HTMLElement).blur()

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Updated label')
  })

  it('a capture-phase pointerdown OUTSIDE commits BEFORE the outside target\'s own handlers run (no dropped text on tool clicks)', async () => {
    const order: string[] = []
    const onCommit = vi.fn(() => order.push('commit'))
    renderOverlay({
      object: makeTextObject({ properties: { text: '' } }),
      mode: 'create',
      onCommit,
    })
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Edit text'), 'Draft text')

    // A stand-in for a sidebar/tool button: its own pointerdown handler
    // must observe the already-committed state.
    const button = document.createElement('button')
    button.addEventListener('pointerdown', () => order.push('button-handler'))
    document.body.appendChild(button)

    button.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, composed: true }),
    )

    expect(order).toEqual(['commit', 'button-handler'])
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Draft text')
    button.remove()
  })

  it('a pointerdown INSIDE the textarea does not commit', async () => {
    const onCommit = vi.fn()
    renderOverlay({ mode: 'edit', onCommit })

    screen.getByLabelText('Edit text').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    )

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits exactly once — an Enter commit followed by blur/outside-pointerdown is not a double commit', async () => {
    const onCommit = vi.fn()
    renderOverlay({ mode: 'edit', onCommit })
    const user = userEvent.setup()

    await user.keyboard('{Enter}')
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    )

    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('after Escape, later blur does not resurrect a commit (one terminal call)', async () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    renderOverlay({ mode: 'edit', onCommit, onCancel })
    const user = userEvent.setup()

    await user.keyboard('{Escape}')
    ;(document.activeElement as HTMLElement | null)?.blur()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('mirrors the object\'s styling and stage transform (font metrics scaled by zoom, position from stagePosition + zoom)', () => {
    render(
      <TextEditOverlay
        object={makeTextObject({
          x: 100,
          y: 80,
          properties: {
            text: 'Styled',
            font_family: 'Georgia',
            font_size: 20,
            bold: true,
            italic: true,
            color: '#ff0000',
          },
        })}
        mode="edit"
        zoom={2}
        stagePosition={{ x: 10, y: 20 }}
        getStage={() => null}
        onCommit={() => {}}
        onCancel={() => {}}
      />,
    )

    const textarea = screen.getByLabelText('Edit text')
    expect(textarea.style.fontFamily).toBe('Georgia')
    expect(textarea.style.fontSize).toBe('40px') // 20 * zoom 2
    expect(textarea.style.fontWeight).toBe('bold')
    expect(textarea.style.fontStyle).toBe('italic')
    // container origin (0,0 — null stage) + stagePosition + x/y * zoom
    expect(textarea.style.left).toBe('210px') // 10 + 100 * 2
    expect(textarea.style.top).toBe('180px') // 20 + 80 * 2
  })
})
