import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type Konva from 'konva'
import { apiClient } from '../api/client'
import {
  MAX_RASTER_UPLOAD_BYTES,
  UPLOAD_BAD_EXTENSION_MESSAGE,
  UPLOAD_RASTER_TOO_BIG_MESSAGE,
  type ObjectVariant,
} from '../hooks/useVariants'
import * as ToastContextModule from '../notifications/ToastContext'
import { useCanvasStore } from '../state/canvasStore'
import { colorForType } from './ObjectShape'
import { Sidebar } from './Sidebar'
import { SYMBOLS } from './symbols'
import { CATALOG_TYPES } from './types'

/** Mirror of Sidebar's internal CATALOG_LABELS (not exported): the header
 * text each type's card shows. */
const CATALOG_LABELS_FOR_TEST: Record<(typeof CATALOG_TYPES)[number], string> = {
  outlines: 'Outline',
  tables: 'Table',
  doors: 'Door',
  chairs: 'Chair',
  furnitures: 'Furniture',
  appliances: 'Appliance',
  lighting: 'Lighting',
}
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

/**
 * U5 (object-visuals): Sidebar now consumes the useVariants hooks, so every
 * render needs a QueryClientProvider (retries off, the repo convention) and
 * a mocked `useToast` (vi.spyOn on the module — same as useObjects.test.tsx
 * / CanvasEditorPage.test.tsx; no ToastProvider needed). `apiClient.get` is
 * stubbed pending-forever by default (see the file-level beforeEach):
 * pre-U5 tests exercise the resilience contract for free — defaults render
 * and drag with the variants query still in flight — and variant tests
 * override the spy with real fixtures.
 */
function renderSidebar(onDrop: (type: string, point: Point) => void = () => {}) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <Sidebar
        getStage={makeFakeStage}
        gridSize={20}
        canvasWidth={800}
        canvasHeight={600}
        onDrop={onDrop}
      />
    </QueryClientProvider>,
  )
}

function makeVariant(overrides: Partial<ObjectVariant> = {}): ObjectVariant {
  return {
    id: 1,
    object_type: 'chairs',
    width: 300,
    height: 150,
    size_bytes: 1234,
    original_name: 'my-chair.png',
    created_at: '2026-07-18T00:00:00Z',
    file_url: '/api/object-variants/1/file/',
    ...overrides,
  }
}

const showError = vi.fn()

beforeEach(() => {
  showError.mockClear()
  vi.spyOn(ToastContextModule, 'useToast').mockReturnValue({
    toasts: [],
    showError,
    dismiss: vi.fn(),
  })
  // Pending-forever default: no test-end act() noise for suites that never
  // await the variants list; variant-specific tests re-stub with fixtures.
  vi.spyOn(apiClient, 'get').mockReturnValue(new Promise(() => {}) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

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
      // The type label moved to the card HEADER (object-visuals
      // follow-up: header + tile-row anatomy). Scope the lookup to the
      // card (the 'Furniture' TYPE label collides with the 'Furniture'
      // SECTION header at document level).
      const cardRoot = card.closest('li')!
      expect(within(cardRoot as HTMLElement).getByText(CATALOG_LABELS_FOR_TEST[type])).toBeInTheDocument()
    }
  })

  it('the thumbnail swap leaves the drag flow intact (pointerdown on a card still starts a drop)', () => {
    const onDrop = vi.fn()
    renderSidebar(onDrop)

    fireEvent.pointerDown(screen.getByTestId('catalog-item-chairs'), { clientX: 10, clientY: 10 })
    // Threshold model (object-visuals follow-up): the press only becomes a
    // DRAG once the pointer travels past the threshold — the move below
    // both crosses it and positions the drop.
    fireEvent(window, new PointerEvent('pointermove', { clientX: 105, clientY: 95 }))
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

describe('Sidebar variant catalog (U5 object-visuals)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ activeTool: 'pan', selectedItemIds: [] })
  })

  /** Re-stubs the shared get spy with a resolved fixture list. */
  function mockVariants(variants: ObjectVariant[]) {
    return vi.spyOn(apiClient, 'get').mockResolvedValue({ data: variants } as never)
  }

  it('renders a variant strip under each type that has uploads — thumbnails named from original_name, no empty tray otherwise (R7/R12)', async () => {
    mockVariants([
      makeVariant({ id: 1, original_name: 'my-chair.png', file_url: '/api/object-variants/1/file/' }),
      makeVariant({ id: 2, original_name: 'stool.svg', file_url: '/api/object-variants/2/file/' }),
      makeVariant({ id: 3, object_type: 'tables', original_name: 'oak-table.jpg' }),
    ])
    renderSidebar()

    // Both chair uploads land in the chairs tile row, the table upload in
    // its own — grouping happens client-side over the single flat list.
    // (Object-visuals follow-up: the row is `catalog-tiles-<type>` and
    // ALWAYS exists — it holds the default tile + [+] even with zero
    // variants; the variant tiles slot between them.)
    // The tile row exists synchronously (default + [+]); the variant
    // tiles arrive when the query resolves — await THEM, not the row.
    const firstTile = await screen.findByTestId('variant-item-1')
    const chairRow = screen.getByTestId('catalog-tiles-chairs')
    expect(within(chairRow).getByTestId('variant-item-1')).toBe(firstTile)
    expect(within(chairRow).getByTestId('variant-item-2')).toBeInTheDocument()
    expect(within(screen.getByTestId('catalog-tiles-tables')).getByTestId('variant-item-3')).toBeInTheDocument()

    // R12: the file-derived name is the tooltip AND part of the accessible
    // name; the thumbnail streams from the authenticated file endpoint.
    const tile = screen.getByTestId('variant-item-1')
    expect(tile).toHaveAttribute('title', 'my-chair.png')
    expect(tile).toHaveAttribute('aria-label', 'Place my-chair.png')
    expect(tile.querySelector('img')).toHaveAttribute('src', '/api/object-variants/1/file/')

    // Zero variants for a type → the row still shows default + [+], but no
    // variant tiles (the no-empty-tray spirit, new anatomy).
    for (const type of ['outlines', 'doors', 'furnitures', 'appliances', 'lighting']) {
      const row = screen.getByTestId(`catalog-tiles-${type}`)
      expect(row.querySelector('[data-testid^="variant-item-"]')).toBeNull()
    }
  })

  it('dragging a variant tile shows its thumbnail preview and passes the variant ref + natural dims into onDrop (F2 seam for U6 aspect-fit)', async () => {
    mockVariants([makeVariant({ id: 7, width: 300, height: 150 })])
    const onDrop = vi.fn()
    renderSidebar(onDrop)

    fireEvent.pointerDown(await screen.findByTestId('variant-item-7'), {
      clientX: 10,
      clientY: 10,
    })
    // Threshold model: the preview appears only once the pointer commits
    // to a DRAG (movement past the threshold) — a bare press is a click.
    expect(screen.queryByTestId('catalog-drag-preview')).not.toBeInTheDocument()
    fireEvent(window, new PointerEvent('pointermove', { clientX: 60, clientY: 40 }))
    const preview = screen.getByTestId('catalog-drag-preview')
    expect(preview.querySelector('img')).toHaveAttribute('src', '/api/object-variants/1/file/')

    fireEvent(window, new PointerEvent('pointerup', { clientX: 105, clientY: 95 }))

    // Identity-transform stage → (105, 95) snapped to the 20px grid, PLUS
    // the optional third argument carrying id + NATURAL dims.
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(
      'chairs',
      { x: 100, y: 100 },
      { id: 7, width: 300, height: 150 },
    )
  })

  it('pressing [+] opens the picker and never starts a drag (pointer ownership, doc-review)', async () => {
    mockVariants([])
    const onDrop = vi.fn()
    const pickerSpy = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => {})
    renderSidebar(onDrop)
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled())

    const uploadButton = screen.getByRole('button', { name: 'Upload Chair image' })
    // The pointerdown that would have started a card-level ghost drag:
    // stopPropagation + tile-owned handlers mean NO preview appears and a
    // release over the canvas drops nothing.
    fireEvent.pointerDown(uploadButton, { clientX: 10, clientY: 10 })
    expect(screen.queryByTestId('catalog-drag-preview')).not.toBeInTheDocument()
    fireEvent(window, new PointerEvent('pointerup', { clientX: 305, clientY: 195 }))
    expect(onDrop).not.toHaveBeenCalled()

    // The click is what opens the hidden file input.
    fireEvent.click(uploadButton)
    expect(pickerSpy).toHaveBeenCalled()
  })

  it('client-side pre-check rejects wrong-extension and oversize files with the friendly toast and NO request (AE2 client half)', async () => {
    mockVariants([])
    const postSpy = vi.spyOn(apiClient, 'post')
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    renderSidebar()
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled())

    // Arm the picker for chairs, then feed it a text file.
    fireEvent.click(screen.getByRole('button', { name: 'Upload Chair image' }))
    const input = screen.getByTestId('variant-upload-input')
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    })
    expect(showError).toHaveBeenCalledWith(UPLOAD_BAD_EXTENSION_MESSAGE)

    // Oversize raster: same toast convention, still no request.
    const big = new File(['x'], 'huge.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: MAX_RASTER_UPLOAD_BYTES + 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Upload Chair image' }))
    fireEvent.change(input, { target: { files: [big] } })
    expect(showError).toHaveBeenCalledWith(UPLOAD_RASTER_TOO_BIG_MESSAGE)

    expect(postSpy).not.toHaveBeenCalled()
  })

  it('a valid pick uploads in flight with [+] disabled (spinner; second click no-ops), then the new variant appears with NO refetch', async () => {
    const getSpy = mockVariants([])
    let releasePost: ((value: unknown) => void) | null = null
    const postSpy = vi.spyOn(apiClient, 'post').mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePost = resolve
        }) as never,
    )
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    renderSidebar()
    await waitFor(() => expect(getSpy).toHaveBeenCalled())

    const uploadButton = screen.getByRole('button', { name: 'Upload Chair image' })
    fireEvent.click(uploadButton)
    fireEvent.change(screen.getByTestId('variant-upload-input'), {
      target: { files: [new File(['png'], 'chair.png', { type: 'image/png' })] },
    })

    // In flight (doc-review): [+] disabled with a spinner — a second click
    // no-ops instead of double-submitting against the R19 quota.
    await waitFor(() => expect(uploadButton).toBeDisabled())
    expect(uploadButton.querySelector('.animate-spin')).not.toBeNull()
    fireEvent.click(uploadButton)
    expect(postSpy).toHaveBeenCalledTimes(1)

    // Release: the server echo MERGES into the cache (setQueryData, never
    // invalidate-and-refetch — the superseded resync learning) and the
    // strip shows the new tile with the list GET still at one call.
    releasePost!({ data: makeVariant({ id: 99, original_name: 'chair.png' }) })
    expect(await screen.findByTestId('variant-item-99')).toBeInTheDocument()
    expect(getSpy).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(uploadButton).toBeEnabled())
  })

  it('delete flows through ConfirmDialog with the exact R18 copy — Cancel keeps, Confirm soft-deletes and removes the tile only', async () => {
    mockVariants([makeVariant({ id: 4, original_name: 'my-chair.png' })])
    const deleteSpy = vi.spyOn(apiClient, 'delete').mockResolvedValue({} as never)
    renderSidebar()

    await screen.findByTestId('variant-item-4')
    const removeButton = within(screen.getByTestId('catalog-tiles-chairs')).getByRole(
      'button',
      { name: 'Remove my-chair.png' },
    )
    // Always-visible + keyboard-focusable (doc-review: a11y — never
    // hover-reveal): a real button, present without any hover simulation.
    expect(removeButton).not.toHaveAttribute('tabindex', '-1')

    fireEvent.click(removeButton)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // R18 copy VERBATIM: placed objects unaffected, no erasure implied.
    expect(within(dialog).getByText('Remove from catalog?')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'Remove this item from your catalog? Objects already placed keep this image, and the upload still counts toward your storage.',
      ),
    ).toBeInTheDocument()
    // Initial focus on the SAFE action: Enter can never destroy by default.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    // Cancel keeps the variant — nothing fired, tile intact.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('variant-item-4')).toBeInTheDocument()

    // Confirm removes it from the strip only (soft-delete server-side; the
    // cache filter is the client half — no refetch).
    fireEvent.click(removeButton)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    // The mutationFn runs in a microtask after mutate() — same waitFor
    // convention as useObjects.test.tsx's save assertions.
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('/object-variants/4/'))
    await waitFor(() =>
      expect(screen.queryByTestId('variant-item-4')).not.toBeInTheDocument(),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it("the delete button's pointerdown never starts a drag, and Escape closes the dialog WITHOUT reaching window-level handlers", async () => {
    mockVariants([makeVariant({ id: 5 })])
    const onDrop = vi.fn()
    renderSidebar(onDrop)

    const removeButton = await screen.findByRole('button', { name: 'Remove my-chair.png' })
    // Pointer ownership: pressing delete must NEVER begin a ghost drag.
    fireEvent.pointerDown(removeButton, { clientX: 10, clientY: 10 })
    expect(screen.queryByTestId('catalog-drag-preview')).not.toBeInTheDocument()
    fireEvent(window, new PointerEvent('pointerup', { clientX: 305, clientY: 195 }))
    expect(onDrop).not.toHaveBeenCalled()

    // Escape ownership (UserMenu pattern): dismissing the dialog stops
    // propagation, so the canvas's window-level Escape handler never sees
    // the keystroke.
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      fireEvent.click(removeButton)
      fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(windowKeydown).not.toHaveBeenCalled()
      // Cancelled — the variant survives.
      expect(screen.getByTestId('variant-item-5')).toBeInTheDocument()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('defaults render and drag even when the variants query ERRORS — the catalog is never gated on the network (resilience)', async () => {
    const getSpy = vi.spyOn(apiClient, 'get').mockRejectedValue({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })
    const onDrop = vi.fn()
    renderSidebar(onDrop)
    await waitFor(() => expect(getSpy).toHaveBeenCalled())

    // Defaults have zero network dependency: all 7 tiles present, no strips,
    // no toast (read-only query errors degrade silently, like useObjects).
    for (const type of CATALOG_TYPES) {
      expect(screen.getByTestId(`catalog-item-${type}`)).toBeInTheDocument()
      const row = screen.getByTestId(`catalog-tiles-${type}`)
      expect(row.querySelector('[data-testid^="variant-item-"]')).toBeNull()
    }
    expect(showError).not.toHaveBeenCalled()

    // ...and the default drag contract is untouched (exact two-arg call;
    // the pointermove crosses the click-vs-drag threshold).
    fireEvent.pointerDown(screen.getByTestId('catalog-item-tables'), { clientX: 10, clientY: 10 })
    fireEvent(window, new PointerEvent('pointermove', { clientX: 305, clientY: 195 }))
    fireEvent(window, new PointerEvent('pointerup', { clientX: 305, clientY: 195 }))
    expect(onDrop).toHaveBeenCalledExactlyOnceWith('tables', { x: 300, y: 200 })
  })
})

describe('click-to-arm placement (object-visuals follow-up)', () => {
  /** Same shape as the U5 describe's helper (scoped there). */
  function mockVariants(variants: ObjectVariant[]) {
    return vi.spyOn(apiClient, 'get').mockResolvedValue({ data: variants } as never)
  }

  it('clicking the default tile ARMS the placement (place tool, null variant); clicking again disarms to pan', async () => {
    mockVariants([])
    const user = userEvent.setup()
    renderSidebar()

    const tile = screen.getByTestId('catalog-item-chairs')
    await user.click(tile)

    expect(useCanvasStore.getState().activeTool).toBe('place')
    expect(useCanvasStore.getState().placement).toEqual({ type: 'chairs', variant: null })
    expect(tile).toHaveAttribute('aria-pressed', 'true')

    await user.click(tile)
    expect(useCanvasStore.getState().activeTool).toBe('pan')
    expect(useCanvasStore.getState().placement).toBeNull()
    expect(tile).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking a VARIANT tile arms with the reference payload; another tile re-arms without passing through pan', async () => {
    mockVariants([makeVariant({ id: 9, width: 300, height: 150 })])
    const user = userEvent.setup()
    renderSidebar()

    await user.click(await screen.findByTestId('variant-item-9'))
    expect(useCanvasStore.getState().placement).toEqual({
      type: 'chairs',
      variant: { id: 9, width: 300, height: 150 },
    })

    // Re-arm straight onto the default tile: the payload swaps.
    await user.click(screen.getByTestId('catalog-item-tables'))
    expect(useCanvasStore.getState().placement).toEqual({ type: 'tables', variant: null })
    expect(useCanvasStore.getState().activeTool).toBe('place')
  })

  it('a sub-threshold press-release is a CLICK (arms, no drop); a completed drag suppresses the arming click', async () => {
    mockVariants([])
    const onDrop = vi.fn()
    renderSidebar(onDrop)
    const tile = screen.getByTestId('catalog-item-chairs')

    // Jiggle under the threshold, then release: arms, never drops.
    fireEvent.pointerDown(tile, { clientX: 10, clientY: 10 })
    fireEvent(window, new PointerEvent('pointermove', { clientX: 12, clientY: 11 }))
    fireEvent(window, new PointerEvent('pointerup', { clientX: 12, clientY: 11 }))
    fireEvent.click(tile)
    expect(onDrop).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().activeTool).toBe('place')

    // Reset, then a REAL drag: drops once, and the click that the browser
    // fires after pointerup must NOT toggle the placement.
    useCanvasStore.getState().setPlacement(null)
    fireEvent.pointerDown(tile, { clientX: 10, clientY: 10 })
    fireEvent(window, new PointerEvent('pointermove', { clientX: 105, clientY: 95 }))
    fireEvent(window, new PointerEvent('pointerup', { clientX: 105, clientY: 95 }))
    fireEvent.click(tile)
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(useCanvasStore.getState().activeTool).toBe('pan')
    expect(useCanvasStore.getState().placement).toBeNull()
  })
})
