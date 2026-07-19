import { describe, expect, it, vi } from 'vitest'
import {
  afterNextPaint,
  awaitVariantImages,
  collectVariantImageUrls,
  downloadDataUrl,
  EXPORT_FILENAME,
  EXPORT_IMAGES_TIMEOUT_MESSAGE,
  exportStageToPng,
} from './export'
import type { RegistryWaitDeps } from './export'
import { VISUAL_VARIANT_ID_KEY, variantFileUrl } from './visuals'
import type { CanvasObject } from './types'

type VisualItem = Pick<CanvasObject, 'type' | 'properties'>

/**
 * `exportStageToPng` wraps a real `Konva.Stage.toDataURL()` call and a real
 * browser download (`<a download>` click) — neither is meaningfully
 * testable in jsdom (no real `<canvas>` rendering, per this codebase's
 * established "no real Konva mounted in tests" convention; see
 * `LineAnchorHandles.test.tsx`'s doc comment). Per the plan's own stated
 * bar for this unit: exact pixel output is NOT asserted here. What IS
 * tested, thoroughly:
 *   - The clear-selection-before-snapshot SEQUENCING: `clearSelection()` is
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

describe('collectVariantImageUrls (U7)', () => {
  it('maps valid variant references to file URLs, deduped, ignoring everything else', () => {
    const items: VisualItem[] = [
      { type: 'chairs', properties: { [VISUAL_VARIANT_ID_KEY]: 7 } },
      { type: 'tables', properties: { [VISUAL_VARIANT_ID_KEY]: 7 } }, // same variant twice -> one URL
      { type: 'chairs', properties: { [VISUAL_VARIANT_ID_KEY]: 9 } },
      { type: 'chairs', properties: {} }, // default symbol
      { type: 'chairs', properties: { [VISUAL_VARIANT_ID_KEY]: 'garbage' } }, // fails the parser
      { type: 'shape_rectangle', properties: {} },
    ]
    expect(collectVariantImageUrls(items)).toEqual([variantFileUrl(7), variantFileUrl(9)])
  })
})

describe('awaitVariantImages (U7)', () => {
  /** Fake registry seams (the injectable-deps convention): entries are a
   * plain map the test mutates; `notify` fires the subscribed listeners
   * like a real registry transition would. */
  function makeFakeRegistry(initial: Record<string, 'pending' | 'loaded' | 'failed'>) {
    const statuses = new Map(Object.entries(initial))
    const listeners = new Map<string, Set<() => void>>()
    const deps: RegistryWaitDeps = {
      peek: (url) => {
        const status = statuses.get(url)
        return status ? { status, refcount: 0, image: null } : null
      },
      subscribe: (url, listener) => {
        if (!listeners.has(url)) listeners.set(url, new Set())
        listeners.get(url)!.add(listener)
        return () => listeners.get(url)?.delete(listener)
      },
    }
    const settle = (url: string, status: 'loaded' | 'failed') => {
      statuses.set(url, status)
      for (const listener of listeners.get(url) ?? []) listener()
    }
    return { deps, settle }
  }

  it('resolves ready immediately when nothing is pending (loaded, failed, and ABSENT entries never block)', async () => {
    const { deps } = makeFakeRegistry({ '/a': 'loaded', '/b': 'failed' })
    // '/c' is absent from the registry entirely — no load in flight, so
    // waiting on it could only ever falsely time out (documented choice).
    await expect(awaitVariantImages(['/a', '/b', '/c'], 50, deps)).resolves.toBe('ready')
  })

  it('waits for a pending entry and resolves ready once it settles — including settling as FAILED (R16)', async () => {
    const { deps, settle } = makeFakeRegistry({ '/a': 'pending' })
    const wait = awaitVariantImages(['/a'], 5000, deps)
    settle('/a', 'failed') // failed is SETTLED: the placeholder exports; no abort
    await expect(wait).resolves.toBe('ready')
  })

  it('times out when an entry stays pending', async () => {
    vi.useFakeTimers()
    try {
      const { deps } = makeFakeRegistry({ '/a': 'pending' })
      const wait = awaitVariantImages(['/a'], 3000, deps)
      vi.advanceTimersByTime(3001)
      await expect(wait).resolves.toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores pending entries for URLs OUTSIDE the requested set (plan-switch isolation)', async () => {
    // A leaked pending entry from a previously-open plan must not delay
    // this plan's export: the await-set is derived from current items.
    const { deps } = makeFakeRegistry({ '/other-plans-image': 'pending', '/a': 'loaded' })
    await expect(awaitVariantImages(['/a'], 50, deps)).resolves.toBe('ready')
  })
})

describe('exportStageToPng', () => {
  /** Minimal fake standing in for `Konva.Stage` — only `toDataURL` is
   * exercised by `exportStageToPng`. */
  function makeFakeStage(dataUrl = 'data:image/png;base64,fake') {
    return { toDataURL: vi.fn(() => dataUrl) } as unknown as import('konva').default.Stage
  }

  it('clears the selection before the deferred snapshot, when something is selected', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const stage = makeFakeStage()
    const clearSelection = vi.fn()
    const callOrder: string[] = []
    clearSelection.mockImplementation(() => callOrder.push('clearSelection'))
    ;(stage.toDataURL as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('toDataURL')
      return 'data:image/png;base64,fake'
    })

    await exportStageToPng(() => stage, ['obj-1'], clearSelection, [])

    expect(clearSelection).toHaveBeenCalledTimes(1)
    expect(stage.toDataURL).toHaveBeenCalledTimes(1)
    // The selection clear must happen strictly before the snapshot is taken.
    expect(callOrder).toEqual(['clearSelection', 'toDataURL'])

    rafSpy.mockRestore()
    clickSpy.mockRestore()
  })

  it('does not call clearSelection when the selection is already empty', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const stage = makeFakeStage()
    const clearSelection = vi.fn()

    await exportStageToPng(() => stage, [], clearSelection, [])

    expect(clearSelection).not.toHaveBeenCalled()
    expect(stage.toDataURL).toHaveBeenCalledTimes(1)

    rafSpy.mockRestore()
    clickSpy.mockRestore()
  })

  it('does not snapshot before the two-frame wait completes', async () => {
    const frames: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })

    const stage = makeFakeStage()
    const clearSelection = vi.fn()

    await exportStageToPng(() => stage, ['obj-1', 'obj-2'], clearSelection, [])

    expect(clearSelection).toHaveBeenCalledTimes(1)
    expect(stage.toDataURL).not.toHaveBeenCalled()

    frames[0](0)
    expect(stage.toDataURL).not.toHaveBeenCalled()

    frames[1](0)
    expect(stage.toDataURL).toHaveBeenCalledTimes(1)

    rafSpy.mockRestore()
  })

  it('triggers a download of a non-empty data URL produced by toDataURL', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const appendSpy = vi.spyOn(document.body, 'appendChild')

    const stage = makeFakeStage('data:image/png;base64,realish-payload')
    const clearSelection = vi.fn()

    await exportStageToPng(() => stage, ['obj-1'], clearSelection, [], { filename: 'custom.png' })

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

  it('defaults the download filename to EXPORT_FILENAME', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const appendSpy = vi.spyOn(document.body, 'appendChild')

    const stage = makeFakeStage()
    await exportStageToPng(() => stage, [], vi.fn(), [])

    const anchor = appendSpy.mock.calls.find((call) => (call[0] as HTMLAnchorElement).tagName === 'A')?.[0] as
      | HTMLAnchorElement
      | undefined
    expect(anchor?.download).toBe(EXPORT_FILENAME)

    rafSpy.mockRestore()
    clickSpy.mockRestore()
    appendSpy.mockRestore()
  })

  // ——— U7 (object-visuals): await-then-capture behaviors ———

  /** Deps whose single URL stays pending forever. */
  function pendingForeverDeps(): RegistryWaitDeps {
    return {
      peek: () => ({ status: 'pending', refcount: 0, image: null }),
      subscribe: () => () => {},
    }
  }

  const VARIANT_ITEMS: VisualItem[] = [{ type: 'chairs', properties: { [VISUAL_VARIANT_ID_KEY]: 3 } }]

  it('U7: pending-timeout surfaces the toast message and downloads NOTHING', async () => {
    vi.useFakeTimers()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const stage = makeFakeStage()
      const onImagesTimeout = vi.fn()

      const run = exportStageToPng(() => stage, [], vi.fn(), VARIANT_ITEMS, {
        onImagesTimeout,
        timeoutMs: 3000,
        waitDeps: pendingForeverDeps(),
      })
      vi.advanceTimersByTime(3001)
      await run

      expect(onImagesTimeout).toHaveBeenCalledWith(EXPORT_IMAGES_TIMEOUT_MESSAGE)
      expect(stage.toDataURL).not.toHaveBeenCalled()
      expect(clickSpy).not.toHaveBeenCalled()
    } finally {
      clickSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('U7: a variant image that settles as FAILED does not abort — the capture proceeds (R16)', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const stage = makeFakeStage()
    const onImagesTimeout = vi.fn()
    const failedDeps: RegistryWaitDeps = {
      peek: () => ({ status: 'failed', refcount: 0, image: null }),
      subscribe: () => () => {},
    }

    await exportStageToPng(() => stage, [], vi.fn(), VARIANT_ITEMS, {
      onImagesTimeout,
      waitDeps: failedDeps,
    })

    // The canvas renders the R16 placeholder for the failed image, so the
    // PNG matches the screen; one dead reference never blocks export.
    expect(onImagesTimeout).not.toHaveBeenCalled()
    expect(stage.toDataURL).toHaveBeenCalledTimes(1)

    rafSpy.mockRestore()
    clickSpy.mockRestore()
  })

  it('U7: bails SILENTLY when the stage is gone by the time the await resolves (navigated away)', async () => {
    const { promise, resolve } = (() => {
      let resolveFn!: () => void
      const p = new Promise<void>((r) => {
        resolveFn = () => r()
      })
      return { promise: p, resolve: resolveFn }
    })()

    const listenerRef: { current: (() => void) | null } = { current: null }
    let status: 'pending' | 'loaded' = 'pending'
    const deps: RegistryWaitDeps = {
      peek: () => ({ status, refcount: 0, image: null }),
      subscribe: (_url, l) => {
        listenerRef.current = l
        // Signal the test that the await is armed.
        resolve()
        return () => {}
      },
    }

    const stage = makeFakeStage()
    let stageAlive = true
    const onImagesTimeout = vi.fn()

    const run = exportStageToPng(() => (stageAlive ? stage : null), [], vi.fn(), VARIANT_ITEMS, {
      onImagesTimeout,
      waitDeps: deps,
    })
    await promise
    // The user navigates away, THEN the image finishes loading.
    stageAlive = false
    status = 'loaded'
    listenerRef.current?.()
    await run

    // Silent bail: no toast, no snapshot, no download attempt.
    expect(onImagesTimeout).not.toHaveBeenCalled()
    expect(stage.toDataURL).not.toHaveBeenCalled()
  })
})
