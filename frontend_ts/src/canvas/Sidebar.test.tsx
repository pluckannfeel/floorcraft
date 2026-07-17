import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type Konva from 'konva'
import { useCanvasStore } from '../state/canvasStore'
import { Sidebar } from './Sidebar'
import type { Point } from './types'

/**
 * U9 (canvas-tools): the sidebar tool strip + grouped catalog. Sidebar
 * renders plain DOM (its only Konva touchpoint is the `getStage` prop, used
 * for drop-coordinate conversion), so it mounts directly under jsdom like
 * `Toolbar`/`ContextMenu`. The store is module-global: `activeTool` resets
 * in `beforeEach`.
 *
 * The drag test drives the REAL pointer flow (component `onPointerDown`,
 * then the window-level `pointermove`/`pointerup` listeners) against a stub
 * stage whose absolute transform is the identity — the same "no real Konva
 * in jsdom" boundary every other suite draws, with the transform math
 * itself covered by coordinates.test.ts.
 */

/** Stage stub: 800x600 container at the viewport origin, identity
 * transform (zoom 1, no pan), so client coords pass through to stage
 * coords unchanged. */
function makeFakeStage(): Konva.Stage {
  const container = document.createElement('div')
  container.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  return {
    container: () => container,
    getAbsoluteTransform: () => ({
      copy: () => ({ invert: () => ({ point: (point: Point) => point }) }),
    }),
  } as unknown as Konva.Stage
}

function renderSidebar(onDrop: (type: string, point: Point) => void = () => {}) {
  return render(
    <Sidebar
      getStage={makeFakeStage}
      gridSize={20}
      canvasWidth={800}
      canvasHeight={600}
      onDrop={onDrop}
    />,
  )
}

const TOOL_LABELS = [
  'Pan',
  'Select',
  'Rectangle',
  'Square',
  'Circle',
  'Line',
  'Curved Line',
  'S-Curve Line',
  'Text',
  'Crop',
]

describe('Sidebar tool strip (U9)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ activeTool: 'pan', selectedItemIds: [] })
  })

  it('renders every tool with Pan pressed by default (idle mode)', () => {
    renderSidebar()

    for (const label of TOOL_LABELS) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Pan' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Rectangle' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking a tool activates it; clicking it again deselects back to pan (drag navigates)', async () => {
    renderSidebar()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Rectangle' }))
    expect(useCanvasStore.getState().activeTool).toBe('shape_rectangle')
    expect(screen.getByRole('button', { name: 'Rectangle' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Rectangle' }))
    expect(useCanvasStore.getState().activeTool).toBe('pan')
    expect(screen.getByRole('button', { name: 'Pan' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('the explicit Select button returns from any active tool', async () => {
    renderSidebar()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Crop' }))
    expect(useCanvasStore.getState().activeTool).toBe('crop')

    await user.click(screen.getByRole('button', { name: 'Select' }))
    expect(useCanvasStore.getState().activeTool).toBe('select')
  })
})

describe('Sidebar grouped catalog (U9)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ activeTool: 'pan', selectedItemIds: [] })
  })

  it('renders all 7 catalog items across the three sections, all open by default', () => {
    renderSidebar()

    for (const type of ['outlines', 'tables', 'doors', 'chairs', 'furnitures', 'appliances', 'lighting']) {
      expect(screen.getByTestId(`catalog-item-${type}`)).toBeInTheDocument()
    }
    // The `expanded` option keys on aria-expanded, which only the section
    // headers carry — it also disambiguates the "Furniture" header from the
    // "Furniture" catalog entry (the `furnitures` type shares the name).
    for (const title of ['Structure', 'Furniture', 'Fixtures']) {
      expect(screen.getByRole('button', { name: title, expanded: true })).toBeInTheDocument()
    }
  })

  it('collapsing a section hides ONLY its items; re-expanding restores them', async () => {
    renderSidebar()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Furniture', expanded: true }))

    expect(screen.getByRole('button', { name: 'Furniture', expanded: false })).toBeInTheDocument()
    for (const type of ['tables', 'chairs', 'furnitures']) {
      expect(screen.queryByTestId(`catalog-item-${type}`)).not.toBeInTheDocument()
    }
    // Other sections are untouched.
    expect(screen.getByTestId('catalog-item-outlines')).toBeInTheDocument()
    expect(screen.getByTestId('catalog-item-lighting')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Furniture', expanded: false }))
    expect(screen.getByTestId('catalog-item-tables')).toBeInTheDocument()
  })

  it('drag from a collapsed-then-re-expanded section still drops (snapped) onto the canvas', async () => {
    const onDrop = vi.fn()
    renderSidebar(onDrop)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Furniture', expanded: true }))
    await user.click(screen.getByRole('button', { name: 'Furniture', expanded: false }))

    // The custom pointer flow: pointerdown on the entry starts the drag,
    // the WINDOW pointermove/pointerup listeners track and drop it.
    fireEvent.pointerDown(screen.getByTestId('catalog-item-tables'), { clientX: 10, clientY: 10 })
    fireEvent(window, new PointerEvent('pointermove', { clientX: 305, clientY: 195 }))
    fireEvent(window, new PointerEvent('pointerup', { clientX: 305, clientY: 195 }))

    // Identity transform → stage point (305, 195), snapped to the 20px grid.
    expect(onDrop).toHaveBeenCalledExactlyOnceWith('tables', { x: 300, y: 200 })
  })

  it('releasing OUTSIDE the canvas container does not drop', () => {
    const onDrop = vi.fn()
    renderSidebar(onDrop)

    fireEvent.pointerDown(screen.getByTestId('catalog-item-doors'), { clientX: 10, clientY: 10 })
    fireEvent(window, new PointerEvent('pointerup', { clientX: 900, clientY: 700 }))

    expect(onDrop).not.toHaveBeenCalled()
  })
})
