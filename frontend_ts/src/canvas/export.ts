import type Konva from 'konva'
import { peekImageRegistry, subscribeImageRegistry } from './imageRegistry'
import { parseVariantReference, variantFileUrl } from './visuals'
import type { CanvasObject } from './types'

/** U12: PNG export helpers.
 *
 * Per the plan's Key Technical Decision: export must clear the current
 * selection (detaching both `SelectionTransformer`'s Transformer handles
 * AND `LineAnchorHandles`' anchor Circles, per `CanvasStage.tsx`'s
 * selection-branched rendering — see that file's "which selection UI
 * to show" comment) immediately before `stage.toDataURL()`, so the
 * exported PNG never shows selection/anchor chrome.
 *
 * The tricky part: `clearSelection()` only queues a React state update.
 * `CanvasStage`'s selection branch re-renders asynchronously, and even
 * once React commits, react-konva's own Konva redraw is batched via
 * `Konva.Layer.batchDraw()`, which itself defers to a `requestAnimationFrame`
 * callback (see Konva's `Util._requestAnimFrame`/`Animation` internals) —
 * so a snapshot taken synchronously right after calling `clearSelection()`
 * would very likely still capture the stale, still-attached handles.
 * `afterNextPaint` below waits two animation frames (one for React's commit
 * + the resulting effect that calls `transformer.nodes([])`/unmounts the
 * anchor Circles, a second for Konva's own batched redraw of that change)
 * before invoking the snapshot callback — deliberately NOT a single rAF or
 * a fixed setTimeout, both of which are one frame short of guaranteed-safe
 * for this exact "React state -> effect -> Konva batchDraw" chain.
 */

/** Waits two animation frames before calling `callback` — see this file's
 * doc comment above for why two frames (not one, not a `setTimeout`) is the
 * minimum needed to guarantee a cleared selection has actually been redrawn
 * off the Stage before a snapshot is taken. Exported separately from
 * `exportStageToPng` so it's independently testable without a real
 * `Konva.Stage`. */
export function afterNextPaint(callback: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      callback()
    })
  })
}

/** Creates a temporary `<a download>` element pointing at `dataUrl` and
 * clicks it to trigger a browser download — the standard vanilla-JS
 * data-URL-download recipe (no library needed for this one-shot action). */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

/** Default download filename for `exportStageToPng`. */
export const EXPORT_FILENAME = 'floor-plan.png'

/** U7 (object-visuals): how long export waits for still-loading variant
 * images before giving up. Start point per the plan; tune against real
 * load behavior if 3s proves wrong in practice. */
export const EXPORT_IMAGES_TIMEOUT_MS = 3000

/** The toast copy for a pending-timeout abort (R16: settled-FAILED images
 * never abort — only genuinely indeterminate pending ones do). */
export const EXPORT_IMAGES_TIMEOUT_MESSAGE =
  "Some images haven't finished loading — try exporting again in a moment."

/** U7: the export await-set is derived from the CURRENT plan's items —
 * never from "all registry entries". A stale or leaked entry from a
 * previously-open plan must not be able to delay or block this plan's
 * export (plan-switch isolation; the registry's own eviction runs on the
 * plan-switch reseed, but export must be correct regardless of registry
 * hygiene). Pure: items → valid variant references → file URLs, deduped. */
export function collectVariantImageUrls(
  items: ReadonlyArray<Pick<CanvasObject, 'type' | 'properties'>>,
): string[] {
  const urls = new Set<string>()
  for (const item of items) {
    const variantId = parseVariantReference(item.properties)
    if (variantId !== null) {
      urls.add(variantFileUrl(variantId))
    }
  }
  return [...urls]
}

/** Injectable registry seams for `awaitVariantImages` — the same
 * injectable-dependency convention `computeTransformCommit`'s measureText
 * uses (jsdom tests drive fake registries; production uses the real
 * module functions via the defaults). */
export interface RegistryWaitDeps {
  peek: typeof peekImageRegistry
  subscribe: typeof subscribeImageRegistry
}

const REAL_REGISTRY_DEPS: RegistryWaitDeps = {
  peek: peekImageRegistry,
  subscribe: subscribeImageRegistry,
}

/**
 * U7: waits until none of `urls` is 'pending' in the registry, or the
 * timeout elapses. Resolution rules (plan R16 + doc-review):
 * - Only entries that EXIST and are 'pending' block: a settled-'failed'
 *   entry resolves immediately (the canvas already renders the R16
 *   placeholder for it, so the capture matches the screen — one dead
 *   reference must never make a plan permanently unexportable), and an
 *   ABSENT entry never blocks (it has no load in flight, so waiting on it
 *   could only ever time out and falsely abort the export; absent means no
 *   image branch mounted, which renders nothing to capture anyway).
 * - 'timeout' is returned only when something was still genuinely
 *   indeterminate when the clock ran out.
 */
export function awaitVariantImages(
  urls: ReadonlyArray<string>,
  timeoutMs: number = EXPORT_IMAGES_TIMEOUT_MS,
  deps: RegistryWaitDeps = REAL_REGISTRY_DEPS,
): Promise<'ready' | 'timeout'> {
  const isPending = (url: string) => deps.peek(url)?.status === 'pending'
  const pendingUrls = urls.filter(isPending)
  if (pendingUrls.length === 0) {
    return Promise.resolve('ready')
  }

  return new Promise((resolve) => {
    let settled = false
    const unsubscribes: Array<() => void> = []
    const finish = (result: 'ready' | 'timeout') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const unsubscribe of unsubscribes) unsubscribe()
      resolve(result)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    const recheck = () => {
      if (!pendingUrls.some(isPending)) finish('ready')
    }
    for (const url of pendingUrls) {
      unsubscribes.push(deps.subscribe(url, recheck))
    }
    // A transition may have landed between the filter above and the
    // subscriptions — re-check once so a just-settled entry can't strand
    // the wait until timeout.
    recheck()
  })
}

/** Options for `exportStageToPng`'s U7 await-then-capture behavior. */
export interface ExportStageOptions {
  /** Surfaces the pending-timeout message (the caller owns toast
   * presentation — same split as every other canvas helper). */
  onImagesTimeout?: (message: string) => void
  filename?: string
  timeoutMs?: number
  /** Test seam only. */
  waitDeps?: RegistryWaitDeps
}

/**
 * U7 (object-visuals): awaits the current plan's still-loading variant
 * images (see `awaitVariantImages`), then clears the current selection (if
 * any), waits for that clear to actually take effect on the Stage
 * (`afterNextPaint`), then snapshots the Stage to a PNG data URL and
 * triggers a browser download of it.
 *
 * Takes `getStage` (not a resolved Stage): the await can outlive the
 * editor — a user who navigates away mid-wait must get a SILENT bail (no
 * toast, no download, no `toDataURL` against a destroyed stage), so stage
 * liveness is re-resolved after every asynchronous boundary.
 *
 * The registry's commit-time 'loaded' semantics guarantee an awaited image
 * is actually drawable inside the existing two-rAF window — the await is a
 * contract, not a timing coincidence (see imageRegistry.ts).
 *
 * `selectedItemIds`/`clearSelection`/`items` are passed in (rather than
 * this function reaching into `canvasStore` itself) so it stays a plain,
 * Konva-adjacent function callable/testable without a mounted store or
 * component tree — the "pure logic, thin Konva plumbing at the call site"
 * split every other canvas/*.ts helper follows. U1: the selection is a
 * set — one `clearSelection()` detaches all chrome.
 */
export async function exportStageToPng(
  getStage: () => Konva.Stage | null,
  selectedItemIds: ReadonlyArray<CanvasObject['id']>,
  clearSelection: () => void,
  items: ReadonlyArray<Pick<CanvasObject, 'type' | 'properties'>>,
  options: ExportStageOptions = {},
): Promise<void> {
  const {
    onImagesTimeout,
    filename = EXPORT_FILENAME,
    timeoutMs = EXPORT_IMAGES_TIMEOUT_MS,
    waitDeps,
  } = options

  if (!getStage()) return

  const urls = collectVariantImageUrls(items)
  const waited = await awaitVariantImages(urls, timeoutMs, waitDeps ?? REAL_REGISTRY_DEPS)

  // Navigated away during the await → silent bail (doc-review): no toast
  // (EVEN on the timeout branch — a plan-switch mid-await must never toast
  // over the next plan; review-pass find), no download, and crucially no
  // toDataURL against a destroyed stage. The registry's reset also
  // notifies waiters on plan switch, so this branch is belt-and-suspenders
  // for any other stage-teardown path.
  if (!getStage()) return

  if (waited === 'timeout') {
    onImagesTimeout?.(EXPORT_IMAGES_TIMEOUT_MESSAGE)
    return
  }

  if (selectedItemIds.length > 0) {
    clearSelection()
  }
  // The returned promise settles only after the capture/bail actually ran
  // (not merely when it was scheduled) so callers can hold an in-flight
  // guard across the ENTIRE export (review-pass find: double-click =
  // double download without this).
  await new Promise<void>((resolve) => {
    afterNextPaint(() => {
      // The two-rAF window is itself asynchronous — re-check liveness once
      // more before touching the canvas.
      const stage = getStage()
      if (stage) {
        downloadDataUrl(stage.toDataURL(), filename)
      }
      resolve()
    })
  })
}
