import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type Konva from 'konva'
import { useCanvasStore } from '../state/canvasStore'
import { colorForType } from './ObjectShape'
import { Sidebar } from './Sidebar'
import { SYMBOLS } from './symbols'
import { CATALOG_TYPES } from './types'
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

describe('Sidebar catalog symbol thumbnails (U4 object-visuals)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ activeTool: 'pan', selectedItemIds: [] })
  })

  it('every catalog card shows an inline-SVG thumbnail built from the SAME symbol data the canvas renders, tinted with its type color (R3/R5)', () => {
    renderSidebar()

    for (const type of CATALOG_TYPES) {
      const card = screen.getByTestId(`catalog-item-${type}`)
      const svg = card.querySelector('svg')
      expect(svg, `${type} thumbnail present`).not.toBeNull()
      // One source of truth: viewBox and every path's `d` come verbatim
      // from symbols.ts — the exact data the Konva.Path branch draws.
      expect(svg).toHaveAttribute(
        'viewBox',
        `0 0 ${SYMBOLS[type].viewBox.width} ${SYMBOLS[type].viewBox.height}`,
      )
      expect(svg).toHaveAttribute('fill', colorForType(type))
      const paths = svg!.querySelectorAll('path')
      expect(paths).toHaveLength(SYMBOLS[type].paths.length)
      for (const [index, path] of [...paths].entries()) {
        expect(path.getAttribute('d')).toBe(SYMBOLS[type].paths[index])
        // Filled-geometry contract: tint inherits from the <svg> fill —
        // no per-path styling, and never any stroke.
        expect(path.getAttribute('stroke')).toBeNull()
      }
      // The card's label and drag surface are untouched by the swap.
      expect(card.textContent).not.toBe('')
    }
  })

  it('the thumbnail swap leaves the drag flow intact (pointerdown on a card still starts a drop)', () => {
    const onDrop = vi.fn()
    renderSidebar(onDrop)

    fireEvent.pointerDown(screen.getByTestId('catalog-item-chairs'), { clientX: 10, clientY: 10 })
    fireEvent(window, new PointerEvent('pointerup', { clientX: 105, clientY: 95 }))

    // Identity-transform stage → (105, 95) snapped to the 20px grid.
    expect(onDrop).toHaveBeenCalledExactlyOnceWith('chairs', { x: 100, y: 100 })
  })
})

describe('resizable sidebar (final polish)', () => {
  // jsdom rects are all zeros, so the aside's left edge is 0 and the
  // dragged width equals the pointer's clientX — which is exactly what the
  // component computes (clientX - rect.left).
  it('dragging the right-edge handle resizes the sidebar, clamped to min/max', () => {
    renderSidebar()
    const aside = screen.getByRole('complementary', { name: 'Object catalog' })
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    expect(aside).toHaveStyle({ width: '360px' })

    fireEvent.pointerDown(handle, { clientX: 360 })
    fireEvent(window, new PointerEvent('pointermove', { clientX: 480 }))
    expect(aside).toHaveStyle({ width: '480px' })
    expect(handle).toHaveAttribute('aria-valuenow', '480')

    // Past the max: clamped.
    fireEvent(window, new PointerEvent('pointermove', { clientX: 1200 }))
    expect(aside).toHaveStyle({ width: '600px' })

    // Below the min: clamped.
    fireEvent(window, new PointerEvent('pointermove', { clientX: 50 }))
    expect(aside).toHaveStyle({ width: '240px' })

    // Release ends the resize — later moves are ignored.
    fireEvent(window, new PointerEvent('pointerup', { clientX: 50 }))
    fireEvent(window, new PointerEvent('pointermove', { clientX: 500 }))
    expect(aside).toHaveStyle({ width: '240px' })
  })

  it('arrow keys resize the focused handle in steps, clamped', () => {
    renderSidebar()
    const aside = screen.getByRole('complementary', { name: 'Object catalog' })
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(aside).toHaveStyle({ width: '376px' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(aside).toHaveStyle({ width: '344px' })

    // Clamped at the max however long the key is held.
    for (let i = 0; i < 30; i += 1) fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(aside).toHaveStyle({ width: '600px' })
  })
})
