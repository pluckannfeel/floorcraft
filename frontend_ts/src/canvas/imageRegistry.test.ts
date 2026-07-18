import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { apiClient } from '../api/client'
import {
  AUTH_PROBE_THROTTLE_MS,
  peekImageRegistry,
  resetImageRegistry,
  subscribeImageRegistry,
  useRegistryImage,
} from './imageRegistry'
import type { RegistryImageSnapshot } from './imageRegistry'

/**
 * U6 (object-visuals): the image-load registry's lifetime/commit/failure
 * contracts (plan KTD "Export readiness"; undo-redo learning: load state is
 * STORE-FREE — nothing in this suite ever touches canvasStore, which is
 * itself the point).
 *
 * jsdom never loads real images, so `Image` is stubbed with a controllable
 * fake: tests fire `onload`/`onerror` by hand, which doubles as proof that
 * the registry drives entirely off those callbacks (no timers, no fetch).
 */

class FakeImage {
  static instances: FakeImage[] = []
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  src = ''
  constructor() {
    FakeImage.instances.push(this)
  }
}

function fakeFor(url: string): FakeImage {
  const instance = FakeImage.instances.find((candidate) => candidate.src === url)
  if (!instance) throw new Error(`no Image was created for ${url}`)
  return instance
}

const URL_A = '/api/object-variants/1/file/'
const URL_B = '/api/object-variants/2/file/'
const URL_C = '/api/object-variants/3/file/'

let getSpy: MockInstance

beforeEach(() => {
  resetImageRegistry()
  FakeImage.instances = []
  vi.stubGlobal('Image', FakeImage)
  // The R20 probe rides the shared apiClient so the auth interceptor owns
  // any redirect; a REJECTING probe (exactly what an expired session
  // produces) must be swallowed by the registry — mocking it rejected here
  // doubles as that assertion (an unhandled rejection would fail the run).
  getSpy = vi
    .spyOn(apiClient, 'get')
    .mockRejectedValue({ isAxiosError: true, response: { status: 401 } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('imageRegistry: single shared load + per-node subscription', () => {
  it('starts ONE load per URL however many nodes mount, and hands every node the same decoded element', () => {
    const first = renderHook(() => useRegistryImage(URL_A))
    const second = renderHook(() => useRegistryImage(URL_A))

    // Dedupe: two concurrent nodes, one in-flight element.
    expect(FakeImage.instances).toHaveLength(1)
    expect(first.result.current).toEqual({ image: null, status: 'pending' })
    expect(second.result.current).toEqual({ image: null, status: 'pending' })

    act(() => fakeFor(URL_A).onload!())

    expect(first.result.current.image).not.toBeNull()
    expect(second.result.current.image).toBe(first.result.current.image)
    // Both nodes committed a render with the element, so the commit-time
    // flip has happened by now.
    expect(first.result.current.status).toBe('loaded')
    // Still just the one load.
    expect(FakeImage.instances).toHaveLength(1)
  })

  it('CACHE HIT: a remounted node reads the decoded element synchronously on its FIRST render (no placeholder strobe)', () => {
    const first = renderHook(() => useRegistryImage(URL_A))
    act(() => fakeFor(URL_A).onload!())
    const element = first.result.current.image
    expect(element).not.toBeNull()
    first.unmount()

    // Undo-of-delete remount: record every render's snapshot so the FIRST
    // one is observable — the whole point of the registry over `use-image`
    // (whose state starts undefined and cannot be cache-seeded) is that
    // this render already holds the real image.
    const renders: RegistryImageSnapshot[] = []
    renderHook(() => {
      const snapshot = useRegistryImage(URL_A)
      renders.push(snapshot)
      return snapshot
    })

    expect(renders[0]).toEqual({ image: element, status: 'loaded' })
    // And no second network load was ever started (never retried).
    expect(FakeImage.instances).toHaveLength(1)
  })
})

describe('imageRegistry: lifetime contract (refcount vs cache)', () => {
  it('refcount falls to zero on unmount but the decoded element SURVIVES (undo-of-delete passes through zero)', () => {
    const hook = renderHook(() => useRegistryImage(URL_A))
    act(() => fakeFor(URL_A).onload!())
    expect(peekImageRegistry(URL_A)).toMatchObject({ refcount: 1, status: 'loaded' })

    hook.unmount()

    const entry = peekImageRegistry(URL_A)
    // Refcount is EXPORT BOOKKEEPING ONLY — it hit zero...
    expect(entry?.refcount).toBe(0)
    // ...but the cache deliberately did not evict: the element and its
    // 'loaded' status survive, so the next mount repaints instantly
    // instead of strobing the R16 placeholder.
    expect(entry?.image).not.toBeNull()
    expect(entry?.status).toBe('loaded')
  })

  it('resetImageRegistry() evicts everything — the ONLY eviction path (plan-switch reseed)', () => {
    const hook = renderHook(() => useRegistryImage(URL_A))
    act(() => fakeFor(URL_A).onload!())
    hook.unmount()
    expect(peekImageRegistry(URL_A)).not.toBeNull()

    resetImageRegistry()

    expect(peekImageRegistry(URL_A)).toBeNull()
    // The next plan session starts a FRESH load for the same URL.
    renderHook(() => useRegistryImage(URL_A))
    expect(FakeImage.instances).toHaveLength(2)
    expect(peekImageRegistry(URL_A)).toMatchObject({ status: 'pending', image: null })
  })

  it('a load settling AFTER eviction is ignored (a stale fetch cannot resurrect a dead entry)', () => {
    const hook = renderHook(() => useRegistryImage(URL_A))
    const staleImage = fakeFor(URL_A)
    hook.unmount()
    resetImageRegistry()

    // The old in-flight load settles into the void.
    staleImage.onload!()

    expect(peekImageRegistry(URL_A)).toBeNull()
  })
})

describe('imageRegistry: COMMIT-TIME loaded semantics', () => {
  it("the raw img.onload does NOT flip status — 'loaded' waits for a committed render with the element", () => {
    // Mount starts the load, then the node unmounts BEFORE the fetch
    // settles (e.g. the object was deleted mid-load).
    const hook = renderHook(() => useRegistryImage(URL_A))
    hook.unmount()

    // The fetch settles with NOTHING mounted: the decoded element is
    // cached, but no render has committed with it, so claiming 'loaded'
    // here would lie to U7's export await ("loaded" must imply the swap is
    // DRAWABLE, not merely fetched).
    fakeFor(URL_A).onload!()
    expect(peekImageRegistry(URL_A)).toMatchObject({ status: 'pending' })
    expect(peekImageRegistry(URL_A)?.image).not.toBeNull()

    // A remount renders with the cached element on its first commit — THAT
    // is the moment the post-render effect asserts 'loaded'.
    const remount = renderHook(() => useRegistryImage(URL_A))
    expect(remount.result.current.image).not.toBeNull()
    expect(peekImageRegistry(URL_A)?.status).toBe('loaded')
  })

  it('subscribers (U7 export await) are notified of the commit-time flip', () => {
    renderHook(() => useRegistryImage(URL_A))
    const seen: string[] = []
    const unsubscribe = subscribeImageRegistry(URL_A, () => {
      seen.push(peekImageRegistry(URL_A)?.status ?? 'evicted')
    })

    act(() => fakeFor(URL_A).onload!())

    // Two transitions observed: element attached (still pending), then the
    // committed 'loaded' flip.
    expect(seen).toEqual(['pending', 'loaded'])
    unsubscribe()
  })
})

describe('imageRegistry: failure contract (R16 + R20)', () => {
  it("a failed load settles as 'failed' with no element (placeholder territory) and is never retried", () => {
    const hook = renderHook(() => useRegistryImage(URL_A))

    act(() => fakeFor(URL_A).onerror!())

    expect(hook.result.current).toEqual({ image: null, status: 'failed' })
    // Never retry-looped: remounting consults the settled entry instead of
    // reloading the image.
    hook.unmount()
    const remount = renderHook(() => useRegistryImage(URL_A))
    expect(remount.result.current.status).toBe('failed')
    expect(FakeImage.instances).toHaveLength(1)
  })

  it('N failed images inside the throttle window fire exactly ONE auth probe (R20, doc-review)', () => {
    renderHook(() => useRegistryImage(URL_A))
    renderHook(() => useRegistryImage(URL_B))
    renderHook(() => useRegistryImage(URL_C))

    act(() => {
      fakeFor(URL_A).onerror!()
      fakeFor(URL_B).onerror!()
      fakeFor(URL_C).onerror!()
    })

    // One cheap authenticated GET on an existing lightweight endpoint — the
    // 401 interceptor owns whatever happens next, never this module.
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(getSpy).toHaveBeenCalledWith('/floor-plans/')
  })

  it('a failure AFTER the throttle window fires a fresh probe', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T10:00:00Z'))
    renderHook(() => useRegistryImage(URL_A))
    renderHook(() => useRegistryImage(URL_B))

    act(() => fakeFor(URL_A).onerror!())
    expect(getSpy).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(Date.now() + AUTH_PROBE_THROTTLE_MS + 1))
    act(() => fakeFor(URL_B).onerror!())
    expect(getSpy).toHaveBeenCalledTimes(2)
  })
})
