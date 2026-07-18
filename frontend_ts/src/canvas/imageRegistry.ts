/**
 * U6 (object-visuals): the image-load registry + `useRegistryImage` hook —
 * the SINGLE load path for placed-variant images (plan KTD "Export
 * readiness"; `use-image` was evaluated and dropped because its state
 * starts undefined and cannot be seeded from a cache, so it can never
 * deliver synchronous remount reuse).
 *
 * ARCHITECTURE STANCE — module-level, URL-keyed, OUTSIDE the zustand store.
 * This is the feature's #1 regression-risk boundary (undo-redo learning,
 * docs/solutions/ui-bugs/undo-redo-broken-after-save-2026-07-16.md): async
 * image-load completion must NEVER write to the store — no items writes, no
 * `dirty` flips, no `partialize` growth. If "loaded" flags lived in items,
 * every image completion would push a junk zundo history entry and mark the
 * plan dirty; living here, load state is invisible to undo/redo, the save
 * payload, and the seed/reseed machinery by construction. Per-node render
 * state is React state inside the hook (via `useSyncExternalStore`), also
 * store-free.
 *
 * LIFETIME CONTRACT (plan U6, deepening + doc-review):
 * - Refcounts track mounted nodes for EXPORT BOOKKEEPING ONLY (U7 consumes
 *   them). The decoded element's cache lifetime is decoupled: it SURVIVES
 *   refcount-zero, because undo-of-delete remounts necessarily pass through
 *   zero — evicting there would strobe the exact placeholder this cache
 *   exists to prevent.
 * - Eviction happens ONLY via `resetImageRegistry()`, which
 *   CanvasEditorPage calls from its plan-switch reset effect — consistent
 *   with export's plan-switch isolation (a stale entry from a previous plan
 *   must never block this plan's export, U7).
 * - Status flips to 'loaded' at COMMIT time, never in the raw `img.onload`:
 *   the hook flips it in a post-render effect after a component has
 *   actually rendered with the real image, so "registry loaded" implies
 *   THE SWAP IS DRAWABLE (inside export's existing two-rAF window), not
 *   merely fetched. Until some node commits, a fetched entry stays
 *   'pending' with its decoded element attached.
 *
 * FAILURE CONTRACT (R16 + R20): a failed load settles as 'failed' — the
 * consumer renders the tinted default symbol placeholder and the image is
 * NEVER retry-looped. Because a failure may be a session expiry (the file
 * endpoint is authenticated), exactly one throttled probe request rides the
 * shared apiClient so the app's existing 401/403 interceptor owns the
 * redirect-to-login (flow-analysis C3); the module-wide throttle means N
 * failed images fire ONE probe, not a stampede (doc-review).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { apiClient } from '../api/client'

export type RegistryImageStatus = 'pending' | 'loaded' | 'failed'

/** What the hook hands a node each render: the decoded element (null until
 * the fetch settles successfully) and the entry's commit-semantics status. */
export interface RegistryImageSnapshot {
  image: HTMLImageElement | null
  status: RegistryImageStatus
}

interface RegistryEntry {
  status: RegistryImageStatus
  /** The decoded element, set by the raw onload (status stays 'pending'
   * until a commit — see module doc). Survives refcount-zero. */
  image: HTMLImageElement | null
  /** Mounted-node count — export bookkeeping ONLY, never cache lifetime. */
  refcount: number
  listeners: Set<() => void>
  /** Cached immutable view for `useSyncExternalStore` (stable identity
   * between mutations, so React's snapshot comparison doesn't loop). */
  snapshot: RegistryImageSnapshot
}

/** Shared initial snapshot: also returned for URLs with no entry yet, so a
 * first render (before the post-commit subscribe creates the entry) and the
 * fresh entry read as the SAME snapshot — no tearing re-render. */
const PENDING_EMPTY: RegistryImageSnapshot = { image: null, status: 'pending' }

const registry = new Map<string, RegistryEntry>()

function notify(entry: RegistryEntry): void {
  // Copy first: a listener may unsubscribe (unmount) mid-iteration.
  for (const listener of [...entry.listeners]) listener()
}

/** Cache-miss path: creates the entry and starts the ONE shared load for
 * this URL. Every concurrent node for the same URL dedupes onto this single
 * in-flight element (plan: "one shared load per URL"). */
function ensureEntry(url: string): RegistryEntry {
  const existing = registry.get(url)
  if (existing) return existing
  const entry: RegistryEntry = {
    status: 'pending',
    image: null,
    refcount: 0,
    listeners: new Set(),
    snapshot: PENDING_EMPTY,
  }
  registry.set(url, entry)
  startLoad(url, entry)
  return entry
}

function startLoad(url: string, entry: RegistryEntry): void {
  const image = new Image()
  image.onload = () => {
    // Evicted by a plan-switch reset while in flight? A stale load must not
    // resurrect a dead entry (the next plan session starts its own).
    if (registry.get(url) !== entry) return
    // COMMIT-TIME SEMANTICS: attach the decoded element but do NOT flip
    // status here — 'loaded' must mean "a node committed a render with this
    // element" (drawable), which only `markDrawable` (hook post-render
    // effect) may assert. Subscribed nodes re-render off this notify, and
    // that render's effect performs the flip.
    entry.image = image
    entry.snapshot = { image, status: entry.status }
    notify(entry)
  }
  image.onerror = () => {
    if (registry.get(url) !== entry) return
    // Settled failure: placeholder territory (R16). Never retried — the
    // only ways forward are a remount after `resetImageRegistry()` or the
    // R20 probe below discovering an expired session and redirecting.
    entry.status = 'failed'
    entry.snapshot = { image: null, status: 'failed' }
    notify(entry)
    probeSession()
  }
  // Same-origin URL (variantFileUrl) — session cookie flows, no crossOrigin
  // needed, and the canvas can never be tainted (plan KTD).
  image.src = url
}

/** The commit-time 'loaded' flip (see module doc). Idempotent; no-ops for
 * evicted/failed/imageless entries. */
function markDrawable(url: string): void {
  const entry = registry.get(url)
  if (!entry || entry.image == null || entry.status !== 'pending') return
  entry.status = 'loaded'
  entry.snapshot = { image: entry.image, status: 'loaded' }
  // Other subscribed nodes — and U7's export await — see the flip.
  notify(entry)
}

// ---------------------------------------------------------------------------
// R20: the throttled session probe
// ---------------------------------------------------------------------------

/** Module-wide probe throttle window: however many images fail inside it,
 * exactly ONE probe fires (doc-review: N failed images must not stampede N
 * probes). 30s is deliberately generous — the probe exists to trigger the
 * auth interceptor once, not to poll. */
export const AUTH_PROBE_THROTTLE_MS = 30_000

let lastProbeAt: number | null = null

function probeSession(): void {
  const now = Date.now()
  if (lastProbeAt != null && now - lastProbeAt < AUTH_PROBE_THROTTLE_MS) return
  lastProbeAt = now
  // ONE cheap authenticated GET on an EXISTING lightweight endpoint (the
  // floor-plans list — the dashboard's own query, no new backend surface).
  // The point is the round trip, not the data: if the session expired, the
  // 401/403 lands in apiClient's response interceptor, which owns the
  // redirect-to-login (R30 convention — same reason useVariants' mutations
  // stay silent on auth errors). Every outcome is swallowed here: success
  // means "not an auth problem, the file is just dead → placeholder stands"
  // and failure is the interceptor's business, not ours.
  void apiClient.get('/floor-plans/').catch(() => {})
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Evicts EVERYTHING — the only eviction path (see lifetime contract).
 * Called by CanvasEditorPage's `[floorPlanId]`-keyed plan-switch reset
 * effect, alongside the store/zundo/selection reset: a plan session starts
 * with an empty registry the same way it starts with cleared history, and
 * export's await-set (U7) can never be haunted by a previous plan's
 * entries. Also re-arms the probe throttle — a fresh plan session gets a
 * fresh R20 probe budget.
 *
 * In-flight loads belonging to evicted entries are ignored on arrival (the
 * `registry.get(url) !== entry` guard in startLoad).
 */
export function resetImageRegistry(): void {
  registry.clear()
  lastProbeAt = null
}

/** Read-only view of one entry for U7's export await-set + tests. `null`
 * when the URL has no entry (nothing mounted ever asked for it — export
 * treats that as its own concern, never this module's). */
export function peekImageRegistry(
  url: string,
): { status: RegistryImageStatus; refcount: number; image: HTMLImageElement | null } | null {
  const entry = registry.get(url)
  if (!entry) return null
  return { status: entry.status, refcount: entry.refcount, image: entry.image }
}

/**
 * Subscription primitive for U7's export await (notified on every entry
 * transition, including the commit-time 'loaded' flip). Subscribing ensures
 * the load is started — the "single load path" invariant holds even if
 * export ever races a node mount. Does NOT touch refcount (refcount counts
 * MOUNTED NODES only).
 */
export function subscribeImageRegistry(url: string, listener: () => void): () => void {
  const entry = ensureEntry(url)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
  }
}

/**
 * The hook: reads the registry SYNCHRONOUSLY during render — a cache hit
 * returns the decoded element on the node's FIRST commit (this is the whole
 * point: an undo-of-delete remount repaints the image immediately, no
 * placeholder strobe) — and on miss starts the one shared load, with this
 * node's re-render subscribed to completion via `useSyncExternalStore`
 * (per-node React state; the store is never involved).
 *
 * Consumers render the real image whenever `image` is non-null and the
 * R16 placeholder otherwise; `status` is the registry's commit-semantics
 * state ('pending' with a non-null image = the one-render window in which
 * this hook's own post-render effect performs the 'loaded' flip).
 */
export function useRegistryImage(url: string): RegistryImageSnapshot {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // Post-commit: create the entry / start the shared load on miss,
      // count this node for export bookkeeping, and wire re-renders.
      const entry = ensureEntry(url)
      entry.refcount += 1
      entry.listeners.add(onStoreChange)
      return () => {
        // The captured entry may already be evicted (plan-switch reset runs
        // while unmounts are still flushing) — decrementing a detached
        // entry is harmless, and Math.max keeps bookkeeping non-negative.
        entry.listeners.delete(onStoreChange)
        entry.refcount = Math.max(0, entry.refcount - 1)
      }
    },
    [url],
  )
  const getSnapshot = useCallback(
    () => registry.get(url)?.snapshot ?? PENDING_EMPTY,
    [url],
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  // THE COMMIT-TIME 'loaded' FLIP (plan U6/doc-review): this effect runs
  // after a render in which this node held the decoded element — i.e. the
  // swap is committed and drawable (react-konva commits with React; Konva's
  // batched draw lands within export's existing two-rAF wait) — and only
  // then does the registry claim 'loaded'. The raw img.onload deliberately
  // never flips status (see startLoad).
  useEffect(() => {
    if (snapshot.image != null) markDrawable(url)
  }, [url, snapshot.image])

  return snapshot
}
