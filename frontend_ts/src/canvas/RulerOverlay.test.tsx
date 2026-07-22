import { describe, expect, it } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import type Konva from 'konva'
import { RulerOverlay, buildAxisTicks } from './RulerOverlay'

/**
 * U3 (canvas-rulers-scale): the ruler overlay is a DOM component (NOT Konva),
 * so — unlike the Stage-mounting components — it CAN mount in jsdom (the
 * TextEditOverlay.test.tsx approach). jsdom's getBoundingClientRect returns
 * zeros, so we supply a fake stage whose container() exposes both
 * getBoundingClientRect (real numbers) and closest() → a fake workspace with
 * its own rect + scroll event target. This mirrors Sidebar.test's makeFakeStage.
 */

interface FakeRects {
  stage: { left: number; top: number; width: number; height: number }
  view: { left: number; top: number; width: number; height: number }
}

/** Builds a fake `getStage` returning a stub whose container resolves both
 * the stage rect and a workspace ancestor rect. The workspace element also
 * dispatches 'scroll', so the overlay's scroll-tracking effect is exercised. */
function makeFakeStage(rects: FakeRects) {
  const workspace = document.createElement('div')
  workspace.setAttribute('data-canvas-workspace', '')
  workspace.getBoundingClientRect = () =>
    ({ ...rects.view, right: rects.view.left + rects.view.width, bottom: rects.view.top + rects.view.height }) as DOMRect

  const container = document.createElement('div')
  container.getBoundingClientRect = () =>
    ({ ...rects.stage, right: rects.stage.left + rects.stage.width, bottom: rects.stage.top + rects.stage.height }) as DOMRect
  // closest('[data-canvas-workspace]') must find the workspace.
  container.closest = ((sel: string) => (sel === '[data-canvas-workspace]' ? workspace : null)) as typeof container.closest

  const stage = { container: () => container } as unknown as Konva.Stage
  return { getStage: () => stage, workspace }
}

const BASE_PROPS = {
  zoom: 1,
  stagePosition: { x: 0, y: 0 },
  gridSize: 20,
  realSizePerGridSquare: 0.5, // canonical meters
  unit: 'meters' as const,
}

/** A large viewport so several ticks fall in range. */
const RECTS: FakeRects = {
  stage: { left: 0, top: 0, width: 4000, height: 3000 },
  view: { left: 0, top: 0, width: 800, height: 600 },
}

describe('buildAxisTicks (pure, U3)', () => {
  it('AE4: with 1 square = 0.5 m, gridSize 20, a tick at model 80px is labeled "2.00 m" at screen x 80', () => {
    // zoom 1, stageOrigin 0, stageOffset 0 → screen == model. Window covers 0..800.
    const ticks = buildAxisTicks(1, 20, 0.5, 'meters', 0, 0, 0, 800)
    const twoMetre = ticks.find((t) => t.label === '2.00 m')
    expect(twoMetre).toBeDefined()
    expect(twoMetre!.screen).toBeCloseTo(80, 5) // model 2m = 80px at this scale
  })

  it('pan (stageOffset) shifts every tick by the pan amount', () => {
    const at0 = buildAxisTicks(1, 20, 0.5, 'meters', 0, 0, 0, 800).find((t) => t.label === '2.00 m')!
    const at100 = buildAxisTicks(1, 20, 0.5, 'meters', 0, 100, 0, 800).find((t) => t.label === '2.00 m')!
    expect(at100.screen - at0.screen).toBeCloseTo(100, 5)
  })

  it('AE1: labeled ticks coarsen at low zoom and refine at high zoom (no crowding)', () => {
    const majorsAt = (zoom: number) =>
      buildAxisTicks(zoom, 20, 0.5, 'meters', 0, 0, 0, 800).filter((t) => t.label != null).length
    const low = majorsAt(0.25)
    const high = majorsAt(4)
    // More labeled ticks fit as you zoom in; fewer when zoomed out.
    expect(high).toBeGreaterThan(low)
  })

  it('never emits ticks below the canvas origin (model 0)', () => {
    // stageOffset +200 pushes model 0 to screen 200 — INSIDE the window
    // [0,800]. This is what actually exercises the Math.max(0,…) origin
    // clamp: without it modelStart would be (0-200)/1 = -200 and the ruler
    // would emit negative-coordinate ticks in the left gutter. (An offset
    // pushing the origin off the LEFT instead — e.g. -200 — leaves modelStart
    // already positive and the clamp inert, so it would pass even if deleted.)
    const ticks = buildAxisTicks(1, 20, 0.5, 'meters', 0, 200, 0, 800)
    expect(ticks.length).toBeGreaterThan(0)
    // Reconstruct model from screen: model = (screen - base)/zoom, base = 200.
    for (const t of ticks) {
      expect((t.screen - 200) / 1).toBeGreaterThanOrEqual(-1e-6)
    }
  })

  it('imperial: labels convert meters to feet-inches (canonical-meters semantics)', () => {
    // 1 square = 0.3048 m (= 1 ft); a major every N squares lands on whole feet.
    const ticks = buildAxisTicks(1, 20, 0.3048, 'feet_inches', 0, 0, 0, 800)
    const labels = ticks.filter((t) => t.label != null).map((t) => t.label)
    expect(labels.length).toBeGreaterThan(0)
    // Every label is whole feet (grid = 1 ft), formatted architecturally —
    // meters converted to feet-inches, not the scalar reinterpreted.
    expect(labels.every((l) => /^\d+' 0"$/.test(l!))).toBe(true)
  })

  it('returns nothing for a degenerate transform', () => {
    expect(buildAxisTicks(0, 20, 0.5, 'meters', 0, 0, 0, 800)).toEqual([])
    expect(buildAxisTicks(1, 0, 0.5, 'meters', 0, 0, 0, 800)).toEqual([])
    expect(buildAxisTicks(1, 20, 0.5, 'meters', 0, 0, 800, 0)).toEqual([])
  })
})

describe('RulerOverlay (DOM overlay, U3)', () => {
  it('renders top + left ruler bands and the corner box', () => {
    const { getStage } = makeFakeStage(RECTS)
    render(<RulerOverlay getStage={getStage} {...BASE_PROPS} />)
    expect(screen.getByTestId('ruler-top')).toBeInTheDocument()
    expect(screen.getByTestId('ruler-left')).toBeInTheDocument()
    expect(screen.getByTestId('ruler-corner')).toBeInTheDocument()
  })

  it('AE4: labels a "2.00 m" major tick on the top ruler', () => {
    const { getStage } = makeFakeStage(RECTS)
    render(<RulerOverlay getStage={getStage} {...BASE_PROPS} />)
    expect(within(screen.getByTestId('ruler-top')).getByText('2.00 m')).toBeInTheDocument()
  })

  it('the bands HUG the canvas edges, not the workspace viewport edges', () => {
    // Canvas (stage) inset inside a larger viewport — the real layout: the
    // white canvas floats in the padded, scrollable workspace. The bands
    // must sit at the canvas corner (100,80), NOT the viewport corner (0,0).
    const { getStage } = makeFakeStage({
      stage: { left: 100, top: 80, width: 400, height: 300 },
      view: { left: 0, top: 0, width: 800, height: 600 },
    })
    render(<RulerOverlay getStage={getStage} {...BASE_PROPS} />)

    const corner = screen.getByTestId('ruler-corner')
    expect(corner.style.left).toBe('100px') // canvas left edge, not viewport 0
    expect(corner.style.top).toBe('80px') // canvas top edge, not viewport 0

    const top = screen.getByTestId('ruler-top')
    expect(top.style.top).toBe('80px') // rides the canvas top edge
    expect(top.style.left).toBe('122px') // canvasLeft + corner thickness (22)

    const left = screen.getByTestId('ruler-left')
    expect(left.style.left).toBe('100px') // rides the canvas left edge
    expect(left.style.top).toBe('102px') // canvasTop + corner thickness (22)
  })

  it('clamps a band to the viewport when the canvas is scrolled past the top-left', () => {
    // Canvas origin scrolled ABOVE/LEFT of the viewport (negative rect): the
    // bands stick to the viewport edge (0,0) so they never disappear, even
    // though the canvas corner is off-screen.
    const { getStage } = makeFakeStage({
      stage: { left: -300, top: -200, width: 4000, height: 3000 },
      view: { left: 0, top: 0, width: 800, height: 600 },
    })
    render(<RulerOverlay getStage={getStage} {...BASE_PROPS} />)

    const corner = screen.getByTestId('ruler-corner')
    expect(corner.style.left).toBe('0px') // clamped to viewport, not -300
    expect(corner.style.top).toBe('0px') // clamped to viewport, not -200
  })

  it('AE2: switching the unit prop relabels the ticks to feet-inches', () => {
    const { getStage } = makeFakeStage(RECTS)
    const { rerender } = render(
      <RulerOverlay getStage={getStage} {...BASE_PROPS} unit="meters" />,
    )
    expect(within(screen.getByTestId('ruler-top')).getByText('2.00 m')).toBeInTheDocument()

    rerender(<RulerOverlay getStage={getStage} {...BASE_PROPS} unit="feet_inches" />)
    const top = screen.getByTestId('ruler-top')
    expect(within(top).queryByText('2.00 m')).not.toBeInTheDocument()
    // Architectural feet-inches labels now appear (0.5 m converts to e.g. 1' 8").
    expect(within(top).getAllByText(/^\d+' \d+"$/).length).toBeGreaterThan(0)
  })

  it('review-pass: a workspace scroll re-derives the rect and re-aligns ticks', () => {
    const { getStage, workspace } = makeFakeStage(RECTS)
    const labelsOf = () =>
      within(screen.getByTestId('ruler-top'))
        .queryAllByText(/ m$/)
        .map((el) => el.textContent)

    render(<RulerOverlay getStage={getStage} {...BASE_PROPS} />)
    const before = labelsOf()
    expect(before).toContain('2.00 m') // near the origin, before scrolling

    // Simulate scrolling the canvas far to the LEFT (stage rect origin moves
    // negative): a larger real range comes into view, and the origin-side
    // ticks scroll off. WITHOUT the scroll listener re-deriving the rect the
    // labels would not change at all.
    getStage().container().getBoundingClientRect = () =>
      ({ left: -2000, top: 0, width: 4000, height: 3000, right: 2000, bottom: 3000 }) as DOMRect
    act(() => {
      workspace.dispatchEvent(new Event('scroll'))
    })

    const after = labelsOf()
    expect(after).not.toEqual(before) // the visible range re-derived on scroll
    expect(after).not.toContain('2.00 m') // origin-side ticks scrolled off the left edge
  })

  it('renders nothing when the stage is unavailable (pre-mount / jsdom default)', () => {
    const { container } = render(<RulerOverlay getStage={() => null} {...BASE_PROPS} />)
    expect(container).toBeEmptyDOMElement()
  })
})
