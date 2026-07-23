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
 * dispatches 'scroll', so the overlay's scroll-tracking effect is exercised.
 *
 * Pass `pan` (a mutable live offset) to also expose the Konva `.x()/.y()`
 * position accessors and `.on/.off` event API — the overlay's live-pan
 * follow reads these. `firePan(type)` invokes the registered Stage-target
 * handler (dragstart/dragmove/dragend) after you mutate `pan.offset`. */
function makeFakeStage(rects: FakeRects, pan?: { offset: { x: number; y: number } }) {
  const workspace = document.createElement('div')
  workspace.setAttribute('data-canvas-workspace', '')
  workspace.getBoundingClientRect = () =>
    ({ ...rects.view, right: rects.view.left + rects.view.width, bottom: rects.view.top + rects.view.height }) as DOMRect

  const container = document.createElement('div')
  container.getBoundingClientRect = () =>
    ({ ...rects.stage, right: rects.stage.left + rects.stage.width, bottom: rects.stage.top + rects.stage.height }) as DOMRect
  // closest('[data-canvas-workspace]') must find the workspace.
  container.closest = ((sel: string) => (sel === '[data-canvas-workspace]' ? workspace : null)) as typeof container.closest

  const handlers: Record<string, (event: { target: unknown }) => void> = {}
  const stage = {
    container: () => container,
    ...(pan
      ? {
          x: () => pan.offset.x,
          y: () => pan.offset.y,
          // Konva namespaced events: 'dragmove.rulers' -> bucket 'dragmove'.
          on: (name: string, fn: (event: { target: unknown }) => void) => {
            handlers[name.split('.')[0]] = fn
          },
          off: () => {},
        }
      : {}),
  } as unknown as Konva.Stage

  // Fire a Stage-target pan event (target === stage passes the isPan guard).
  const firePan = (type: 'dragstart' | 'dragmove' | 'dragend') =>
    handlers[type]?.({ target: stage })
  return { getStage: () => stage, workspace, firePan }
}

const BASE_PROPS = {
  zoom: 1,
  stagePosition: { x: 0, y: 0 },
  gridSize: 20,
  // Document as large as the RECTS stage so, at zoom 1 / pan 0, the page rect
  // == the container rect and the visible-window math matches the pre-doc-rect
  // fixtures (docRight clamps to the 800px viewport either way).
  canvasWidth: 4000,
  canvasHeight: 3000,
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

  it('hugs the DOCUMENT (page) rect tracking stagePosition, not the Stage container', () => {
    // Container origin at (0,0), but the PAGE is panned +150,+100 inside it
    // (zoom 1). The ruler must sit at the page corner, not the container's —
    // this is the case the container-rect version got wrong (review photo).
    const { getStage } = makeFakeStage({
      stage: { left: 0, top: 0, width: 4000, height: 3000 },
      view: { left: 0, top: 0, width: 800, height: 600 },
    })
    render(
      <RulerOverlay
        getStage={getStage}
        {...BASE_PROPS}
        stagePosition={{ x: 150, y: 100 }}
        canvasWidth={400}
        canvasHeight={300}
      />,
    )

    const corner = screen.getByTestId('ruler-corner')
    expect(corner.style.left).toBe('150px') // container(0) + pan(150) = page corner
    expect(corner.style.top).toBe('100px')

    // The band ends at the page's own right edge (150 + 400*zoom = 550), not
    // the container's far edge: width = docRight(550) - topStart(150+22).
    const top = screen.getByTestId('ruler-top')
    expect(top.style.width).toBe('378px')
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

  it('follows a live pan off the Stage node and masks labels until the gesture ends', () => {
    // The store's stagePosition only commits on dragend, so mid-pan the
    // overlay must read the live offset off the Stage node and follow it.
    const pan = { offset: { x: 0, y: 0 } }
    const { getStage, firePan } = makeFakeStage(RECTS, pan)
    const { rerender } = render(<RulerOverlay getStage={getStage} {...BASE_PROPS} />)

    const corner = () => screen.getByTestId('ruler-corner')
    const topBand = () => screen.getByTestId('ruler-top')
    // At rest the page's 0,0 corner sits at the container origin.
    expect(corner().style.left).toBe('0px')
    expect(within(topBand()).getByText('2.00 m')).toBeInTheDocument()

    // Gesture start: labels are masked (hidden) for the duration.
    act(() => firePan('dragstart'))
    expect(within(topBand()).queryByText('2.00 m')).not.toBeInTheDocument()
    // …but the tick MARKS still render (the ruler follows, just number-less).
    expect(topBand().querySelectorAll('[data-tick]').length).toBeGreaterThan(0)

    // Drag 120px right: the live node offset moves, so the ruler (hugging the
    // page) follows — its corner tracks the page frame-by-frame. (Only while
    // panning does the overlay read the live node; see the zoom test below.)
    act(() => {
      pan.offset = { x: 120, y: 0 }
      firePan('dragmove')
    })
    expect(corner().style.left).toBe('120px') // followed the pan
    expect(within(topBand()).queryByText('2.00 m')).not.toBeInTheDocument() // still masked

    // Gesture end commits the position to the store → the prop updates; the
    // overlay switches back to trusting the prop, and labels return.
    act(() => firePan('dragend'))
    rerender(<RulerOverlay getStage={getStage} {...BASE_PROPS} stagePosition={{ x: 120, y: 0 }} />)
    expect(corner().style.left).toBe('120px')
    expect(within(topBand()).getByText('2.00 m')).toBeInTheDocument()
  })

  it('trusts the stagePosition PROP when NOT panning, so a wheel-zoom stays aligned', () => {
    // Regression: a wheel-zoom commits new zoom+position to the store together,
    // but the Konva node's x/y lag the props by one commit. If the overlay read
    // the node here it would pair the NEW zoom with an OLD offset and drift the
    // ticks off the grid. The stale node value (999) must be IGNORED — the prop
    // (40,30) wins because we're not panning.
    const pan = { offset: { x: 999, y: 999 } } // stale, pre-commit node value
    const { getStage } = makeFakeStage(RECTS, pan)
    render(<RulerOverlay getStage={getStage} {...BASE_PROPS} stagePosition={{ x: 40, y: 30 }} />)

    const corner = screen.getByTestId('ruler-corner')
    expect(corner.style.left).toBe('40px') // prop offset, not the stale node 999
    expect(corner.style.top).toBe('30px')
  })

  it('renders nothing when the stage is unavailable (pre-mount / jsdom default)', () => {
    const { container } = render(<RulerOverlay getStage={() => null} {...BASE_PROPS} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('appears once the Stage attaches AFTER mount (not blank on first load)', async () => {
    // The real page: getStage() is null on the first render (the Stage ref
    // isn't set yet) and attaching the ref fires no re-render. The overlay
    // must nudge itself once the stage exists, or it stays blank until an
    // unrelated re-render.
    const readyStage = makeFakeStage(RECTS).getStage()
    let current: Konva.Stage | null = null
    render(<RulerOverlay getStage={() => current} {...BASE_PROPS} />)

    // Nothing on the first render — the stage isn't ready.
    expect(screen.queryByTestId('ruler-top')).not.toBeInTheDocument()

    // Ref attaches after mount; the readiness poll picks it up and re-renders.
    current = readyStage
    expect(await screen.findByTestId('ruler-top')).toBeInTheDocument()
    expect(within(screen.getByTestId('ruler-top')).getByText('2.00 m')).toBeInTheDocument()
  })
})
