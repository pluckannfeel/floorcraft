import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as ToastContextModule from '../notifications/ToastContext'
import { Toolbar } from './Toolbar'
import { useCanvasStore } from '../state/canvasStore'
import type { CanvasObject } from './types'

/**
 * U6: the Toolbar's align/distribute section gating. Toolbar renders plain
 * DOM (its only Konva touchpoint is the `getStage` prop, unused unless the
 * export button is clicked), so it mounts directly under jsdom like
 * `ContextMenu`/`PropertyPanel`. The store is module-global: each test
 * seeds `items` directly and resets in `beforeEach`.
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

function renderToolbar(
  selectedItemIds: CanvasObject['id'][],
  handlers: {
    onAlignSelection?: (kind: string) => void
    onDistributeSelection?: (axis: string) => void
  } = {},
) {
  return render(
    <Toolbar
      getStage={() => null}
      selectedItemIds={selectedItemIds}
      onReorderZIndex={() => {}}
      onAlignSelection={handlers.onAlignSelection ?? (() => {})}
      onDistributeSelection={handlers.onDistributeSelection ?? (() => {})}
    />,
  )
}

const ALIGN_LABELS = [
  'Align left',
  'Align horizontal center',
  'Align right',
  'Align top',
  'Align vertical middle',
  'Align bottom',
]

describe('Toolbar align/distribute section (U6)', () => {
  beforeEach(() => {
  // U7 (object-visuals): Toolbar consumes useToast for the export
  // pending-timeout message — spied like every other suite (no provider).
  vi.spyOn(ToastContextModule, 'useToast').mockReturnValue({
    toasts: [],
    showError: vi.fn(),
    dismiss: vi.fn(),
  })
    useCanvasStore.setState({ items: [], selectedItemIds: [] })
    useCanvasStore.temporal.getState().clear()
  })

  it('hides the whole section for 0 or 1 selected items', () => {
    useCanvasStore.setState({ items: [makeObject({ id: 'a' })] })

    const { rerender } = renderToolbar([])
    expect(screen.queryByRole('button', { name: 'Align left' })).not.toBeInTheDocument()

    rerender(
      <Toolbar
        getStage={() => null}
        selectedItemIds={['a']}
        onReorderZIndex={() => {}}
        onAlignSelection={() => {}}
        onDistributeSelection={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Align left' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Distribute horizontally' })).not.toBeInTheDocument()
  })

  it('shows all six align buttons enabled for 2 selected items, distribute disabled with the "needs 3+ objects" tooltip', () => {
    useCanvasStore.setState({
      items: [makeObject({ id: 'a' }), makeObject({ id: 'b', x: 100 })],
    })

    renderToolbar(['a', 'b'])

    for (const label of ALIGN_LABELS) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled()
    }
    const distributeH = screen.getByRole('button', { name: 'Distribute horizontally' })
    const distributeV = screen.getByRole('button', { name: 'Distribute vertically' })
    expect(distributeH).toBeDisabled()
    expect(distributeV).toBeDisabled()
    // The tooltip rides the wrapping span (the disabled button itself is
    // pointer-events-none) — one per distribute button.
    expect(screen.getAllByTitle('needs 3+ objects')).toHaveLength(2)
  })

  it('enables distribute at 3+ BOXES (3 loose items)', () => {
    useCanvasStore.setState({
      items: [
        makeObject({ id: 'a' }),
        makeObject({ id: 'b', x: 100 }),
        makeObject({ id: 'c', x: 300 }),
      ],
    })

    renderToolbar(['a', 'b', 'c'])

    expect(screen.getByRole('button', { name: 'Distribute horizontally' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Distribute vertically' })).toBeEnabled()
    expect(screen.queryByTitle('needs 3+ objects')).not.toBeInTheDocument()
  })

  it('counts a group as ONE box: a whole group + 1 loose item (3 raw items) keeps distribute disabled', () => {
    useCanvasStore.setState({
      items: [
        makeObject({ id: 'g1', group_key: 'group-1' }),
        makeObject({ id: 'g2', x: 60, group_key: 'group-1' }),
        makeObject({ id: 'loose', x: 300 }),
      ],
    })

    renderToolbar(['g1', 'g2', 'loose'])

    expect(screen.getByRole('button', { name: 'Align left' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Distribute horizontally' })).toBeDisabled()
  })

  it('2 groups + 1 loose item = 3 boxes → distribute enabled', () => {
    useCanvasStore.setState({
      items: [
        makeObject({ id: 'a1', group_key: 'group-1' }),
        makeObject({ id: 'a2', x: 60, group_key: 'group-1' }),
        makeObject({ id: 'b1', x: 200, group_key: 'group-2' }),
        makeObject({ id: 'b2', x: 260, group_key: 'group-2' }),
        makeObject({ id: 'loose', x: 400 }),
      ],
    })

    renderToolbar(['a1', 'a2', 'b1', 'b2', 'loose'])

    expect(screen.getByRole('button', { name: 'Distribute horizontally' })).toBeEnabled()
  })

  it('clicking an align button dispatches its kind; distribute dispatches its axis', async () => {
    useCanvasStore.setState({
      items: [
        makeObject({ id: 'a' }),
        makeObject({ id: 'b', x: 100 }),
        makeObject({ id: 'c', x: 300 }),
      ],
    })
    const onAlignSelection = vi.fn()
    const onDistributeSelection = vi.fn()
    renderToolbar(['a', 'b', 'c'], { onAlignSelection, onDistributeSelection })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Align left' }))
    await user.click(screen.getByRole('button', { name: 'Align bottom' }))
    await user.click(screen.getByRole('button', { name: 'Distribute horizontally' }))

    expect(onAlignSelection).toHaveBeenNthCalledWith(1, 'left')
    expect(onAlignSelection).toHaveBeenNthCalledWith(2, 'bottom')
    expect(onDistributeSelection).toHaveBeenCalledExactlyOnceWith('horizontal')
  })

  it('ghost selection ids (matching no items) do not open the section', () => {
    useCanvasStore.setState({ items: [makeObject({ id: 'real' })] })

    renderToolbar(['ghost-1', 'ghost-2'])

    expect(screen.queryByRole('button', { name: 'Align left' })).not.toBeInTheDocument()
  })
})

describe('export in-flight guard (review-pass fix)', () => {
  it('rapid Export clicks run ONE export (no duplicate downloads/toasts)', async () => {
    // The export now awaits pending images (up to ~3s) before capturing,
    // so an unguarded second click would start an overlapping export —
    // the exact double-fire class handleSave's saveInFlightRef guards.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const stage = {
      toDataURL: vi.fn(() => 'data:image/png;base64,fake'),
    } as unknown as import('konva').default.Stage

    render(
      <Toolbar
        getStage={() => stage}
        selectedItemIds={[]}
        onReorderZIndex={() => {}}
        onAlignSelection={() => {}}
        onDistributeSelection={() => {}}
      />,
    )

    const user = userEvent.setup()
    const exportButton = screen.getByRole('button', { name: /export png/i })
    // Two immediate clicks: the second lands while the first export's
    // await chain (registry wait + two-rAF capture window) is in flight.
    await user.click(exportButton)
    await user.click(exportButton)

    // Give the rAF-driven capture time to complete fully.
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    expect(stage.toDataURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)

    clickSpy.mockRestore()
  })
})
