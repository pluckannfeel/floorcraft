import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { RulerOverlay, buildBoxTicks } from './RulerOverlay'

/**
 * The ruler is a plain child of the canvas box: a model coordinate `M` sits
 * at `M * zoom` box-pixels in. No stage, no rects, no screen coordinates —
 * so these tests are straight arithmetic and plain DOM, and the whole class
 * of "ruler drifted off the canvas" bugs can't be expressed here anymore.
 */

const BASE_PROPS = {
  zoom: 1,
  gridSize: 20,
  canvasWidth: 800, // model px
  canvasHeight: 600,
  realSizePerGridSquare: 0.5, // canonical meters
  unit: 'meters' as const,
}

describe('buildBoxTicks (pure)', () => {
  it('AE4: 1 square = 0.5 m over gridSize 20 puts "2.00 m" at model 80 → 80px at zoom 1', () => {
    const ticks = buildBoxTicks(800, 1, 20, 0.5, 'meters')
    const twoMetre = ticks.find((t) => t.label === '2.00 m')
    expect(twoMetre).toBeDefined()
    expect(twoMetre!.px).toBeCloseTo(80, 5)
  })

  it('scales tick positions by zoom (the box renders the page at `zoom`)', () => {
    const at1 = buildBoxTicks(800, 1, 20, 0.5, 'meters').find((t) => t.label === '2.00 m')!
    const at2 = buildBoxTicks(800, 2, 20, 0.5, 'meters').find((t) => t.label === '2.00 m')!
    expect(at2.px).toBeCloseTo(at1.px * 2, 5)
  })

  it('starts at the page origin and never runs past its far edge', () => {
    const ticks = buildBoxTicks(800, 1, 20, 0.5, 'meters')
    expect(ticks[0].px).toBe(0) // origin tick
    for (const t of ticks) {
      expect(t.px).toBeGreaterThanOrEqual(0)
      expect(t.px).toBeLessThanOrEqual(800) // never past the page
    }
  })

  it('AE1: labels coarsen when zoomed out and refine when zoomed in (no crowding)', () => {
    const majors = (zoom: number) =>
      buildBoxTicks(800, zoom, 20, 0.5, 'meters').filter((t) => t.label != null).length
    expect(majors(4)).toBeGreaterThan(majors(0.25))
  })

  it('imperial: labels convert canonical meters to feet-inches', () => {
    // 1 square = 0.3048 m (= 1 ft), so majors land on whole feet.
    const labels = buildBoxTicks(800, 1, 20, 0.3048, 'feet_inches')
      .filter((t) => t.label != null)
      .map((t) => t.label!)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.every((l) => /^\d+' 0"$/.test(l))).toBe(true)
  })

  it('returns nothing for a degenerate page or transform', () => {
    expect(buildBoxTicks(800, 0, 20, 0.5, 'meters')).toEqual([])
    expect(buildBoxTicks(800, 1, 0, 0.5, 'meters')).toEqual([])
    expect(buildBoxTicks(0, 1, 20, 0.5, 'meters')).toEqual([])
  })
})

describe('RulerOverlay (box-relative DOM)', () => {
  it('renders the two bands and the corner', () => {
    render(<RulerOverlay {...BASE_PROPS} />)
    expect(screen.getByTestId('ruler-top')).toBeInTheDocument()
    expect(screen.getByTestId('ruler-left')).toBeInTheDocument()
    expect(screen.getByTestId('ruler-corner')).toBeInTheDocument()
  })

  it('bands span the page and sit in the MARGIN just outside it', () => {
    render(<RulerOverlay {...BASE_PROPS} />)
    // Top band: full page width, one thickness ABOVE the page (never over it).
    const top = screen.getByTestId('ruler-top')
    expect(top.style.width).toBe('800px')
    expect(top.style.top).toBe('-22px')
    expect(top.style.left).toBe('0px')
    // Left band: full page height, one thickness LEFT of the page.
    const left = screen.getByTestId('ruler-left')
    expect(left.style.height).toBe('600px')
    expect(left.style.left).toBe('-22px')
    expect(left.style.top).toBe('0px')
    // Corner tucks into the outside top-left.
    const corner = screen.getByTestId('ruler-corner')
    expect(corner.style.left).toBe('-22px')
    expect(corner.style.top).toBe('-22px')
  })

  it('bands grow with zoom so they always match the page they border', () => {
    const { rerender } = render(<RulerOverlay {...BASE_PROPS} zoom={1} />)
    expect(screen.getByTestId('ruler-top').style.width).toBe('800px')
    rerender(<RulerOverlay {...BASE_PROPS} zoom={2} />)
    // Page is 1600px wide at 2x, so the ruler is too — they can't disagree.
    expect(screen.getByTestId('ruler-top').style.width).toBe('1600px')
    expect(screen.getByTestId('ruler-left').style.height).toBe('1200px')
  })

  it('AE4: labels a "2.00 m" major on the top ruler', () => {
    render(<RulerOverlay {...BASE_PROPS} />)
    expect(within(screen.getByTestId('ruler-top')).getByText('2.00 m')).toBeInTheDocument()
  })

  it('AE2: switching the unit re-labels the same physical sizes', () => {
    const { rerender } = render(<RulerOverlay {...BASE_PROPS} unit="meters" />)
    expect(within(screen.getByTestId('ruler-top')).getByText('2.00 m')).toBeInTheDocument()

    rerender(<RulerOverlay {...BASE_PROPS} unit="feet_inches" />)
    const top = screen.getByTestId('ruler-top')
    expect(within(top).queryByText('2.00 m')).not.toBeInTheDocument()
    expect(within(top).getAllByText(/^\d+' \d+"$/).length).toBeGreaterThan(0)
  })

})
