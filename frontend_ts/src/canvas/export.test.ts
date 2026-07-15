import { describe, expect, it, vi } from 'vitest'
import { afterNextPaint, downloadDataUrl, EXPORT_FILENAME, exportStageToPng } from './export'

/**
 * `exportStageToPng` wraps a real `Konva.Stage.toDataURL()` call and a real
 * browser download (`<a download>` click) — neither is meaningfully
 * testable in jsdom (no real `<canvas>` rendering, per this codebase's
 * established "no real Konva mounted in tests" convention; see
 * `LineAnchorHandles.test.tsx`'s doc comment). Per the plan's own stated
 * bar for this unit: exact pixel output is NOT asserted here. What IS
 * tested, thoroughly:
 *   - The clear-selection-before-snapshot SEQUENCING: `selectItem(null)` is
 *     called before `stage.toDataURL()`, and `toDataURL()` isn't called
 *     until after the `afterNextPaint` wait — this is the actual bug this
 *     unit exists to avoid (a naive "clear then immediately snapshot" would
 *     race React's async re-render, per the plan's Key Technical Decision).
 *   - `toDataURL()`'s result reaching `downloadDataUrl` (i.e. driving a
 *     download) — proven directly against a mocked `Konva.Stage`.
 *   - `afterNextPaint` actually defers via two frames, not zero — proven
 *     against a mocked `requestAnimationFrame`.
 *   - `downloadDataUrl`'s `<a download>` click recipe, against the real
 *     jsdom DOM.
 */

describe('afterNextPaint', () => {
  it('does not invoke the callback synchronously', () => {
    const callback = vi.fn()
    afterNextPaint(callback)
    expect(callback).not.toHaveBeenCalled()
  })

  it('waits for two animation frames before invoking the callback', () => {
    const frames: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })

    const callback = vi.fn()
    afterNextPaint(callback)

    // Only the first frame has been requested/queued so far.
    expect(frames).toHaveLength(1)
    expect(callback).not.toHaveBeenCalled()

    // Flushing the first frame schedules (but doesn't yet run) the second.
    frames[0](0)
    expect(callback).not.toHaveBeenCalled()
    expect(frames).toHaveLength(2)

    // Only after the second frame flushes does the callback finally run.
    frames[1](0)
    expect(callback).toHaveBeenCalledTimes(1)

    rafSpy.mockRestore()
  })
})

describe('downloadDataUrl', () => {
  it('creates a temporary anchor pointing at the data URL and clicks it', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const appendSpy = vi.spyOn(document.body, 'appendChild')
    const removeSpy = vi.spyOn(document.body, 'removeChild')

    downloadDataUrl('data:image/png;base64,abc', 'my-plan.png')

    expect(appendSpy).toHaveBeenCalled()
    const anchor = appendSpy.mock.calls[0][0] as HTMLAnchorElement
    expect(anchor.tagName).toBe('A')
    expect(anchor.href).toBe('data:image/png;base64,abc')
    expect(anchor.download).toBe('my-plan.png')
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledWith(anchor)

    clickSpy.mockRestore()
    appendSpy.mockRestore()
    removeSpy.mockRestore()
  })
})

describe('exportStageToPng', () => {
  /** Minimal fake standing in for `Konva.Stage` — only `toDataURL` is
   * exercised by `exportStageToPng`. */
  function makeFakeStage(dataUrl = 'data:image/png;base64,fake') {
    return { toDataURL: vi.fn(() => dataUrl) } as unknown as import('konva').default.Stage
  }

  it('clears the selection before the deferred snapshot, when something is selected', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const stage = makeFakeStage()
    const selectItem = vi.fn()
    const callOrder: string[] = []
    selectItem.mockImplementation(() => callOrder.push('selectItem(null)'))
    ;(stage.toDataURL as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('toDataURL')
      return 'data:image/png;base64,fake'
    })

    exportStageToPng(stage, 'obj-1', selectItem)

    expect(selectItem).toHaveBeenCalledWith(null)
    expect(stage.toDataURL).toHaveBeenCalledTimes(1)
    // The selection clear must happen strictly before the snapshot is taken.
    expect(callOrder).toEqual(['selectItem(null)', 'toDataURL'])

    rafSpy.mockRestore()
    clickSpy.mockRestore()
  })

  it('does not call selectItem when nothing is currently selected', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const stage = makeFakeStage()
    const selectItem = vi.fn()

    exportStageToPng(stage, null, selectItem)

    expect(selectItem).not.toHaveBeenCalled()
    expect(stage.toDataURL).toHaveBeenCalledTimes(1)

    rafSpy.mockRestore()
    clickSpy.mockRestore()
  })

  it('does not snapshot before the two-frame wait completes', () => {
    const frames: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })

    const stage = makeFakeStage()
    const selectItem = vi.fn()

    exportStageToPng(stage, 'obj-1', selectItem)

    expect(selectItem).toHaveBeenCalledWith(null)
    expect(stage.toDataURL).not.toHaveBeenCalled()

    frames[0](0)
    expect(stage.toDataURL).not.toHaveBeenCalled()

    frames[1](0)
    expect(stage.toDataURL).toHaveBeenCalledTimes(1)

    rafSpy.mockRestore()
  })

  it('triggers a download of a non-empty data URL produced by toDataURL', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const appendSpy = vi.spyOn(document.body, 'appendChild')

    const stage = makeFakeStage('data:image/png;base64,realish-payload')
    const selectItem = vi.fn()

    exportStageToPng(stage, 'obj-1', selectItem, 'custom.png')

    const anchor = appendSpy.mock.calls.find((call) => (call[0] as HTMLAnchorElement).tagName === 'A')?.[0] as
      | HTMLAnchorElement
      | undefined
    expect(anchor).toBeDefined()
    expect(anchor?.href).toBe('data:image/png;base64,realish-payload')
    expect(anchor?.href.length).toBeGreaterThan(0)
    expect(anchor?.download).toBe('custom.png')
    expect(clickSpy).toHaveBeenCalledTimes(1)

    rafSpy.mockRestore()
    clickSpy.mockRestore()
    appendSpy.mockRestore()
  })

  it('defaults the download filename to EXPORT_FILENAME', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const appendSpy = vi.spyOn(document.body, 'appendChild')

    const stage = makeFakeStage()
    exportStageToPng(stage, null, vi.fn())

    const anchor = appendSpy.mock.calls.find((call) => (call[0] as HTMLAnchorElement).tagName === 'A')?.[0] as
      | HTMLAnchorElement
      | undefined
    expect(anchor?.download).toBe(EXPORT_FILENAME)

    rafSpy.mockRestore()
    clickSpy.mockRestore()
    appendSpy.mockRestore()
  })
})
