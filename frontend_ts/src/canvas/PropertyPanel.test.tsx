import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PropertyPanel } from './PropertyPanel'
import { useCanvasStore } from '../state/canvasStore'
import type { CanvasObject } from './types'

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

function resetStore(items: CanvasObject[] = [], selectedItemId: CanvasObject['id'] | null = null) {
  useCanvasStore.setState({ items, selectedItemId, activeTool: 'select' })
  useCanvasStore.temporal.getState().clear()
}

describe('PropertyPanel (U10)', () => {
  beforeEach(() => {
    resetStore()
  })

  it('renders nothing when no item is selected', () => {
    resetStore([makeItem()], null)
    const { container } = render(<PropertyPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('selecting an item populates the panel with its current name/properties', () => {
    resetStore(
      [makeItem({ name: 'A/C Unit 1', properties: { btu: '12000', color: 'white' } })],
      'item-1',
    )
    render(<PropertyPanel />)

    expect(screen.getByLabelText('Name')).toHaveValue('A/C Unit 1')
    expect(screen.getByLabelText('Property value for btu')).toHaveValue('12000')
    expect(screen.getByLabelText('Property value for color')).toHaveValue('white')
  })

  it('editing the name field and blurring saves the change exactly once (not per keystroke)', async () => {
    resetStore([makeItem({ name: 'Old Name' })], 'item-1')
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
    resetStore([makeItem({ properties: { color: 'red' } })], 'item-1')
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
      'line-1',
    )
    render(<PropertyPanel />)

    expect(screen.queryByLabelText(/Property key points/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Property key curve_style/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Property key label_color')).toBeInTheDocument()
  })

  it('switching selection while a field is mid-edit commits the pending edit first', async () => {
    resetStore(
      [makeItem({ id: 'item-1', name: 'First' }), makeItem({ id: 'item-2', name: 'Second' })],
      'item-1',
    )
    render(<PropertyPanel />)
    const user = userEvent.setup()

    const nameInput = screen.getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'First Edited')

    // No blur yet — switch selection directly via the store, simulating a
    // click on a different canvas item.
    expect(useCanvasStore.getState().items[0].name).toBe('First')
    useCanvasStore.getState().selectItem('item-2')

    await waitFor(() => {
      expect(useCanvasStore.getState().items.find((item) => item.id === 'item-1')?.name).toBe('First Edited')
    })
    // Still untracked even though committed via the selection-switch path.
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)

    // The panel now reflects the newly-selected item.
    expect(screen.getByLabelText('Name')).toHaveValue('Second')
  })

  it('deleting a property row removes it from the saved properties', async () => {
    resetStore([makeItem({ properties: { color: 'red', size: 'large' } })], 'item-1')
    render(<PropertyPanel />)
    const user = userEvent.setup()

    await user.click(screen.getByLabelText('Delete property color'))

    await waitFor(() => {
      expect(useCanvasStore.getState().items[0].properties).toEqual({ size: 'large' })
    })
    expect(useCanvasStore.temporal.getState().pastStates).toHaveLength(0)
  })

  it('adding a new property and blurring saves it alongside existing properties', async () => {
    resetStore([makeItem({ properties: { color: 'red' } })], 'item-1')
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
      'item-1',
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

    useCanvasStore.getState().selectItem('item-2')
    useCanvasStore.getState().selectItem('item-1')

    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('Renamed')
    })
  })
})
