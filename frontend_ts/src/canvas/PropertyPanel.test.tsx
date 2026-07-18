import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PropertyPanel } from './PropertyPanel'
import { setTextMeasurer } from './TextTool'
import { useCanvasStore } from '../state/canvasStore'
import type { CanvasObject } from './types'
import { VISUAL_VARIANT_ID_KEY } from './visuals'

/**
 * Unlike `ShapeTool`/`SelectionTransformer`, `PropertyPanel` renders plain
 * DOM (no Konva `Stage`), so it can be mounted and interacted with directly
 * via `@testing-library/react` — no jsdom-canvas limitation here.
 */

function makeItem(overrides: Partial<CanvasObject> = {}): CanvasObject {
  return {
    id: 'item-1',
    floor_plan: 1,
    type: 'appliances',
    name: '',
    x: 10,
    y: 10,
    width: 40,
    height: 40,
    rotation: 0,
    z_index: 0,
    properties: {},
    ...overrides,
  }
}

function resetStore(items: CanvasObject[] = [], selectedItemIds: CanvasObject['id'][] = []) {
  useCanvasStore.setState({ items, selectedItemIds, activeTool: 'select' })
  useCanvasStore.temporal.getState().clear()
}

describe('PropertyPanel (U10)', () => {
  beforeEach(() => {
    resetStore()
  })

  it('renders nothing when no item is selected', () => {
    resetStore([makeItem()], [])
    const { container } = render(<PropertyPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('selecting an item populates the panel with its current name/properties', () => {
    resetStore(
      [makeItem({ name: 'A/C Unit 1', properties: { btu: '12000', color: 'white' } })],
      ['item-1'],
    )
    render(<PropertyPanel />)

    expect(screen.getByLabelText('Name')).toHaveValue('A/C Unit 1')
    expect(screen.getByLabelText('Property value for btu')).toHaveValue('12000')
    expect(screen.getByLabelText('Property value for color')).toHaveValue('white')
  })

  it('editing the name field and blurring saves the change exactly once (not per keystroke)', async () => {
    resetStore([makeItem({ name: 'Old Name' })], ['item-1'])
    render(<PropertyPanel />)
    const user = userEvent.setup()

    const nameInput = screen.getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'New Name')

    // Mid-typing: the store must not have been written to yet.
    expect(useCanvasStore.getState().items[0].name).toBe('Old Name')

    await user.tab() // blur

    await waitFor(() => {
      expect(useCanvasStore.getState().items[0].name).toBe('New Name')
    })
    // Untracked: no undo history entry from a property-panel edit (R15).
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('editing a generic property field and blurring saves the change', async () => {
    resetStore([makeItem({ properties: { color: 'red' } })], ['item-1'])
    render(<PropertyPanel />)
    const user = userEvent.setup()

    const valueInput = screen.getByLabelText('Property value for color')
    await user.clear(valueInput)
    await user.type(valueInput, 'blue')

    expect(useCanvasStore.getState().items[0].properties.color).toBe('red')

    await user.tab()

    await waitFor(() => {
      expect(useCanvasStore.getState().items[0].properties.color).toBe('blue')
    })
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('excludes Line-structural keys (points, curve_style) from the generic editor', () => {
    resetStore(
      [
        makeItem({
          id: 'line-1',
          type: 'line_straight',
          properties: {
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 10 },
            ],
            curve_style: 'straight',
            label_color: 'black',
          },
        }),
      ],
      ['line-1'],
    )
    render(<PropertyPanel />)

    expect(screen.queryByLabelText(/Property key points/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Property key curve_style/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Property key label_color')).toBeInTheDocument()
  })

  it('switching selection while a field is mid-edit commits the pending edit first', async () => {
    resetStore(
      [makeItem({ id: 'item-1', name: 'First' }), makeItem({ id: 'item-2', name: 'Second' })],
      ['item-1'],
    )
    render(<PropertyPanel />)
    const user = userEvent.setup()

    const nameInput = screen.getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'First Edited')

    // No blur yet — switch selection directly via the store, simulating a
    // click on a different canvas item.
    expect(useCanvasStore.getState().items[0].name).toBe('First')
    useCanvasStore.getState().replaceSelection(['item-2'])

    await waitFor(() => {
      expect(useCanvasStore.getState().items.find((item) => item.id === 'item-1')?.name).toBe('First Edited')
    })
    // Still untracked even though committed via the selection-switch path.
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)

    // The panel now reflects the newly-selected item.
    expect(screen.getByLabelText('Name')).toHaveValue('Second')
  })

  it('deleting a property row removes it from the saved properties', async () => {
    resetStore([makeItem({ properties: { color: 'red', size: 'large' } })], ['item-1'])
    render(<PropertyPanel />)
    const user = userEvent.setup()

    await user.click(screen.getByLabelText('Delete property color'))

    await waitFor(() => {
      expect(useCanvasStore.getState().items[0].properties).toEqual({ size: 'large' })
    })
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('adding a new property and blurring saves it alongside existing properties', async () => {
    resetStore([makeItem({ properties: { color: 'red' } })], ['item-1'])
    render(<PropertyPanel />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '+ Add property' }))
    await user.type(screen.getByLabelText('New property key'), 'material')
    await user.click(document.body) // blur key field before typing value
    await user.type(screen.getByLabelText(/Property value for material/), 'wood')
    await user.tab()

    await waitFor(() => {
      expect(useCanvasStore.getState().items[0].properties).toEqual({ color: 'red', material: 'wood' })
    })
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('reselecting the same item after editing shows the saved values', async () => {
    resetStore(
      [makeItem({ id: 'item-1', name: 'First' }), makeItem({ id: 'item-2', name: 'Second' })],
      ['item-1'],
    )
    render(<PropertyPanel />)
    const user = userEvent.setup()

    const nameInput = screen.getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Renamed')
    await user.tab()

    await waitFor(() => {
      expect(useCanvasStore.getState().items[0].name).toBe('Renamed')
    })

    useCanvasStore.getState().replaceSelection(['item-2'])
    useCanvasStore.getState().replaceSelection(['item-1'])

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Renamed')
    })
  })

  it('does not revert a Line\'s points if they change externally (e.g. via LineAnchorHandles) while a generic field is edited', async () => {
    const originalPoints = [{ x: 0, y: 0 }, { x: 10, y: 10 }]
    resetStore(
      [
        makeItem({
          type: 'line_straight',
          properties: { points: originalPoints, curve_style: 'straight', label: 'wall a' },
        }),
      ],
      ['item-1'],
    )
    render(<PropertyPanel />)
    const user = userEvent.setup()

    // Simulate `LineAnchorHandles` reshaping the line via a direct store
    // write — same mechanism U17 uses, and does NOT remount this form
    // (same item.id key), so `PropertyPanel`'s internal refs are never
    // reset by this.
    const reshapedPoints = [{ x: 5, y: 5 }, { x: 20, y: 20 }]
    useCanvasStore.setState((state) => ({
      items: state.items.map((item) =>
        item.id === 'item-1' ? { ...item, properties: { ...item.properties, points: reshapedPoints } } : item,
      ),
    }))

    // Now edit an unrelated, generic property field and blur.
    const labelInput = screen.getByLabelText('Property value for label')
    await user.clear(labelInput)
    await user.type(labelInput, 'wall b')
    await user.tab()

    await waitFor(() => {
      expect(useCanvasStore.getState().items[0].properties.label).toBe('wall b')
    })
    // The reshape must survive the unrelated commit, not revert to the
    // points captured when this form first mounted.
    expect(useCanvasStore.getState().items[0].properties.points).toEqual(reshapedPoints)
  })
})

// U1 (canvas-tools): the panel's exactly-one contract over the selection
// SET — the editable form renders only for exactly one selected item; 2+
// shows a count placeholder; 0 renders nothing (covered above).
/**
 * U6 (object-visuals; R15): a catalog object's variant reference —
 * `visual_variant_id` in `properties` — is structural data with the same
 * hide-and-preserve treatment as a Line's `points`, PLUS the commit-side
 * guard: hiding alone can't stop "+ Add property" from typing the reserved
 * key by hand, and an unguarded commit would clobber the numeric reference
 * with a string, silently demoting the placed image to its placeholder
 * symbol forever (the C1 corruption vector; doc-review: adversarial).
 */
describe('PropertyPanel variant-reference safety (U6, object-visuals: R15)', () => {
  const makeVariantChair = (overrides: Partial<CanvasObject> = {}) =>
    makeItem({
      id: 'chair-1',
      type: 'chairs',
      properties: { [VISUAL_VARIANT_ID_KEY]: 12, material: 'leather' },
      ...overrides,
    })

  beforeEach(() => {
    resetStore()
  })

  it('the reference key NEVER renders as an editable row (hide-and-preserve, like points)', () => {
    resetStore([makeVariantChair()], ['chair-1'])
    render(<PropertyPanel />)

    expect(screen.queryByLabelText(`Property key ${VISUAL_VARIANT_ID_KEY}`)).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText(`Property value for ${VISUAL_VARIANT_ID_KEY}`),
    ).not.toBeInTheDocument()
    // Ordinary keys still edit normally alongside it.
    expect(screen.getByLabelText('Property value for material')).toHaveValue('leather')
  })

  it('editing an UNRELATED property (and the name) preserves the reference VERBATIM — a number, not a string', async () => {
    resetStore([makeVariantChair()], ['chair-1'])
    render(<PropertyPanel />)
    const user = userEvent.setup()

    const nameInput = screen.getByLabelText('Name')
    await user.type(nameInput, 'Lounge chair')
    const materialInput = screen.getByLabelText('Property value for material')
    await user.clear(materialInput)
    await user.type(materialInput, 'suede')
    await user.tab()

    await waitFor(() => {
      expect(useCanvasStore.getState().items[0].properties.material).toBe('suede')
    })
    // VERBATIM: same key, same NUMBER — `rowsToProperties` stringifies
    // everything it touches, so the reference surviving as a number proves
    // it rode the excluded-keys preserve path, not the row editor
    // (a stringified '12' would fail the defensive parser and kill the
    // image render).
    expect(useCanvasStore.getState().items[0].properties[VISUAL_VARIANT_ID_KEY]).toBe(12)
    expect(useCanvasStore.getState().items[0].name).toBe('Lounge chair')
    // Still untracked (R15's other half: property edits create no history).
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('"+ Add property" with the RESERVED key is dropped at commit — the stored reference survives', async () => {
    resetStore([makeVariantChair()], ['chair-1'])
    render(<PropertyPanel />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '+ Add property' }))
    await user.type(screen.getByLabelText('New property key'), VISUAL_VARIANT_ID_KEY)
    await user.click(document.body) // blur key field before typing value
    await user.type(screen.getByLabelText(`Property value for ${VISUAL_VARIANT_ID_KEY}`), '999')
    await user.tab()

    // The reserved-key row was filtered out of the committed properties
    // (commit-side guard) — the stored reference is untouched, still 12,
    // still a number; nothing else changed either.
    await waitFor(() => {
      expect(useCanvasStore.getState().items[0].properties).toEqual({
        [VISUAL_VARIANT_ID_KEY]: 12,
        material: 'leather',
      })
    })
  })

  it('the commit-side guard covers EVERY excluded key: a hand-typed "points" row cannot clobber a Line', async () => {
    resetStore(
      [
        makeItem({
          id: 'line-1',
          type: 'line_straight',
          properties: {
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 10 },
            ],
            curve_style: 'straight',
          },
        }),
      ],
      ['line-1'],
    )
    render(<PropertyPanel />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '+ Add property' }))
    await user.type(screen.getByLabelText('New property key'), 'points')
    await user.click(document.body)
    await user.type(screen.getByLabelText(/Property value for points/), 'garbage')
    await user.tab()

    await waitFor(() => {
      expect(useCanvasStore.getState().items[0].properties.points).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ])
    })
  })

  it('a NON-catalog shape has no reserved visual key — the key stays freely editable there', () => {
    // The exclusion is catalog-scoped: shapes/lines/text never render
    // variants, so a user-authored `visual_variant_id` row on a shape is
    // just data (and resolveBoxVisual ignores it — non-catalog types stay
    // plain).
    resetStore(
      [makeItem({ id: 'shape-1', type: 'shape_rectangle', properties: { [VISUAL_VARIANT_ID_KEY]: 3 } })],
      ['shape-1'],
    )
    render(<PropertyPanel />)

    expect(screen.getByLabelText(`Property key ${VISUAL_VARIANT_ID_KEY}`)).toBeInTheDocument()
  })
})

describe('PropertyPanel multi-selection (U1)', () => {
  beforeEach(() => {
    resetStore()
  })

  it('renders the editable form when exactly one item is selected', () => {
    resetStore(
      [makeItem({ id: 'item-1', name: 'Only One' }), makeItem({ id: 'item-2' })],
      ['item-1'],
    )
    render(<PropertyPanel />)

    expect(screen.getByLabelText('Name')).toHaveValue('Only One')
    expect(screen.queryByText(/objects selected/)).not.toBeInTheDocument()
  })

  it('shows an "N objects selected" placeholder (no form) when 2+ items are selected', () => {
    resetStore(
      [
        makeItem({ id: 'item-1' }),
        makeItem({ id: 'item-2' }),
        makeItem({ id: 'item-3' }),
      ],
      ['item-1', 'item-3'],
    )
    render(<PropertyPanel />)

    expect(screen.getByText('2 objects selected')).toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Add property' })).not.toBeInTheDocument()
  })

  it('counts only ids that resolve to live items (a stale id renders no form for a ghost)', () => {
    resetStore([makeItem({ id: 'item-1', name: 'Real' })], ['item-1', 'ghost-id'])
    render(<PropertyPanel />)

    // One live item + one dead id -> exactly-one semantics, form renders.
    expect(screen.getByLabelText('Name')).toHaveValue('Real')
  })
})

describe('PropertyPanel text styling (U7)', () => {
  const makeText = (overrides: Partial<CanvasObject> = {}) =>
    makeItem({
      id: 'text-1',
      type: 'text' as CanvasObject['type'],
      width: 80,
      height: 20,
      properties: {
        text: 'Meeting Room',
        font_family: 'Arial',
        font_size: 16,
        bold: false,
        italic: false,
        color: '#111111',
      },
      ...overrides,
    })

  beforeEach(() => {
    setTextMeasurer(() => ({ width: 123, height: 45 }))
  })

  it('renders the styling controls for a text object and hides styling keys from the generic rows', () => {
    resetStore([makeText()], ['text-1'])
    render(<PropertyPanel />)

    expect(screen.getByLabelText('Font')).toHaveValue('Arial')
    expect(screen.getByLabelText('Size')).toHaveValue(16)
    expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument()
    // Styling keys never appear as generic key/value rows (they have
    // dedicated controls instead — e.g. the color input below).
    expect(screen.queryByDisplayValue('font_family')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('color')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Color')).toHaveValue('#111111')
  })

  it('commits a font family change UNTRACKED and mirrors the measured box', async () => {
    resetStore([makeText()], ['text-1'])
    const user = userEvent.setup()
    render(<PropertyPanel />)

    await user.selectOptions(screen.getByLabelText('Font'), 'Georgia')

    const item = useCanvasStore.getState().items[0]
    expect(item.properties.font_family).toBe('Georgia')
    expect(item.properties.text).toBe('Meeting Room') // content preserved
    // Mirrored box recomputed through the injected measurer.
    expect(item.width).toBe(123)
    expect(item.height).toBe(45)
    // R15: styling is not undoable — no history entry was pushed.
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('toggles bold via aria-pressed and clamps the font size draft on blur', async () => {
    resetStore([makeText()], ['text-1'])
    const user = userEvent.setup()
    render(<PropertyPanel />)

    await user.click(screen.getByRole('button', { name: 'Bold' }))
    expect(useCanvasStore.getState().items[0].properties.bold).toBe(true)
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    const size = screen.getByLabelText('Size')
    await user.clear(size)
    await user.type(size, '1')
    await user.tab() // blur commits, clamped to MIN_TEXT_FONT_SIZE
    expect(
      useCanvasStore.getState().items[0].properties.font_size as number,
    ).toBeGreaterThanOrEqual(4)
  })
})
