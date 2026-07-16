import { useEffect, useMemo } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AxiosError } from 'axios'
import { apiClient } from '../api/client'
import { registerPersistenceDispatcher } from '../state/canvasStore'
import { useCanvasStore } from '../state/canvasStore'
import type { CanvasObject } from '../canvas/types'
import { DEFAULT_FLOOR_PLAN_ID } from '../canvas/types'
import { useToast } from '../notifications/ToastContext'

/**
 * Read-only query for a FloorPlan's Objects: `GET /api/objects/?floor_plan=<id>`
 * (backend/fm_generator/urls.py registers `objects` on the DRF router;
 * `ObjectViewSet.get_queryset` filters on the `floor_plan` query param).
 *
 * `['objects', floorPlanId]` is the SAME query key every U13 mutation below
 * uses for its `onSettled` invalidation — this is the plan's single shared
 * cache key across all mutation types (Key Technical Decisions).
 */
export function useObjects(floorPlanId: number = DEFAULT_FLOOR_PLAN_ID) {
  return useQuery({
    queryKey: ['objects', floorPlanId],
    queryFn: async () => {
      const { data } = await apiClient.get<CanvasObject[]>('/objects/', {
        params: { floor_plan: floorPlanId },
      })
      return data
    },
  })
}

/**
 * U13 architecture note (this file + `canvasStore.ts` + `CanvasEditorPage.tsx`):
 *
 * The plan's Key Technical Decisions describe optimistic mutations scoped
 * "per-item, not per-list, in the shared React Query cache." Taken
 * literally, that assumes the canonical, rendered state of an Object lives
 * in the React Query cache itself. It doesn't, in this codebase: U7-U12/
 * U15-U18 already built a fully local-first canvas where the Zustand
 * `canvasStore`'s `items` array is what's actually rendered, moved, and
 * undo/redo-tracked — React Query's cache here is only ever the INITIAL
 * fetch's result (seeded into the store once via `setItems`, see
 * `CanvasEditorPage.tsx`) and now, as of this unit, an eventual-consistency
 * refetch target on `onSettled`. Re-architecting the whole canvas to read
 * from the RQ cache instead of the store would be a much larger, riskier
 * change than this unit's actual goal (wiring the ALREADY-instant local
 * mutations to real persistence + rollback).
 *
 * So the per-item snapshot/restore this file implements targets the
 * ZUSTAND STORE, not the RQ cache — functionally identical to the plan's
 * intent (each mutation restores only the one item it touched, never the
 * whole list, so one mutation's failure can't clobber a different,
 * still-in-flight mutation's unconfirmed change) but adapted to where this
 * codebase's live state actually is. Concretely: every mutation below takes
 * a `previous` snapshot of the affected item as part of its variables —
 * captured by the CALLER (`CanvasEditorPage.tsx`'s handlers) at the same
 * moment it makes the optimistic local change (which, per R16, already
 * happens instantly via the store's existing `updateItemGeometry`/
 * `deleteItem`/etc. actions, same as before this unit). `onMutate` doesn't
 * need to re-derive that snapshot from the store (by the time `onMutate`
 * runs, the store's optimistic change has already been applied
 * synchronously by the caller) — it just threads `previous` through to
 * `onError`, which restores exactly that one item via
 * `restoreItemUntracked`/`removeItemUntracked`.
 *
 * Wiring decision (store actions vs. mutations): `canvasStore.ts`'s
 * existing actions (`createItemLocal`, `updateItemGeometry`, `deleteItem`,
 * `reorderZIndex`, `updateLinePoints`) stay exactly as pure/local as they
 * already were — U9's undo/redo depends on them staying that way (a plain
 * state traversal, not something that also fires side effects every
 * step). `CanvasEditorPage.tsx`'s event handlers (already the sole call
 * site translating Konva events into store-action calls) are extended to
 * call BOTH the local store action AND the matching mutation from
 * `useObjectPersistence` below, in that order. Undo/redo can't do the same
 * "call both" thing at their call sites (`Toolbar.tsx` just calls the
 * free-standing `undo()`/`redo()` functions, with no per-action knowledge
 * of what changed) — so instead `canvasStore.ts`'s `undo()`/`redo()`
 * snapshot `items` before/after the zundo traversal and diff them
 * (`diffAndDispatchPersistence`), dispatching the same create/update/delete
 * mutations through a registered `PersistenceDispatcher`. This one
 * mechanism is what makes undo/redo "re-issue the same persistence call the
 * original action would have made" for every action type uniformly,
 * without teaching the undo/redo path anything about Konva/UI concerns.
 */

function isAuthError(error: unknown): boolean {
  const status = (error as AxiosError | undefined)?.response?.status
  return status === 401 || status === 403
}

/** Builds the JSON body for `POST /api/objects/` from a full (locally
 * already-created) `CanvasObject` — strips the client-only `id` and any
 * server-only timestamp fields the backend ignores/overwrites on create
 * anyway. */
function toCreatePayload(item: CanvasObject): Record<string, unknown> {
  return {
    floor_plan: item.floor_plan,
    type: item.type,
    name: item.name,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    rotation: item.rotation,
    z_index: item.z_index,
    properties: item.properties,
  }
}

export interface CreateObjectVariables {
  /** The item's current (local-only, or stale-real per undo-of-delete) id
   * — swapped for the server-assigned id on success. */
  localId: CanvasObject['id']
  payload: Record<string, unknown>
}

export interface UpdateObjectVariables {
  id: CanvasObject['id']
  patch: Record<string, unknown>
  /** The item's full state immediately before the optimistic change this
   * mutation is persisting — restored verbatim by `onError` (R17). */
  previous: CanvasObject
}

export interface DeleteObjectVariables {
  id: CanvasObject['id']
  /** The item's full state immediately before the optimistic removal —
   * re-added verbatim by `onError` (R17) if the delete fails. */
  previous: CanvasObject
}

/**
 * `POST /api/objects/` — backs every create flow (sidebar drop, Shape draw,
 * Line draw, and undo-of-delete/redo-of-create's "recreate via new id").
 *
 * `onError` removes the local-only ghost item rather than reverting a
 * position (Key Technical Decisions: a brand-new item has no prior position
 * to revert to) via `removeItemUntracked`. `onSuccess` swaps the local id
 * for the server-assigned one via `swapItemId`, so subsequent updates/
 * deletes on this item target the right backend row.
 *
 * 401/403 is handled by the global axios interceptor (U5/R30) before this
 * `onError` even runs its body — the interceptor's redirect already fired
 * by the time control reaches here (interceptors run first in the promise
 * chain). This `onError` still performs the ghost-removal (harmless/correct
 * regardless of failure reason) but skips the generic toast for auth
 * failures specifically, so the user sees "redirected to login," not a
 * redundant/confusing "couldn't create" toast on their way out (R30 takes
 * precedence over R17's generic revert-and-toast, per Key Technical
 * Decisions).
 */
export function useCreateObject(floorPlanId: number = DEFAULT_FLOOR_PLAN_ID) {
  const queryClient = useQueryClient()
  const { showError } = useToast()

  return useMutation({
    // Shared prefix with useUpdateObject/useDeleteObject below — lets
    // `useIsObjectsMutating` (bottom of this file) count "any mutation for
    // this floor plan still in flight," regardless of which of the three
    // it is.
    mutationKey: ['objects', floorPlanId],
    mutationFn: async (variables: CreateObjectVariables) => {
      const { data } = await apiClient.post<CanvasObject>('/objects/', variables.payload)
      return data
    },
    onSuccess: (created, variables) => {
      useCanvasStore.getState().swapItemId(variables.localId, created)
    },
    onError: (error, variables) => {
      useCanvasStore.getState().removeItemUntracked(variables.localId)
      if (!isAuthError(error)) {
        showError("Couldn't save the new item. It's been removed — please try adding it again.")
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['objects', floorPlanId] })
    },
  })
}

/**
 * `PATCH /api/objects/<id>/` — backs every geometry/property/z-order/
 * line-point update (move, resize, rotate, property-panel edit, bring-to-
 * front/send-to-back, line anchor-handle drag). All of these are PATCHes
 * against the same endpoint with a different `patch` body, so one mutation
 * covers all of them (per the plan's Files note for `useUpdateObject`).
 *
 * `onError` restores exactly the one affected item (`previous`, captured by
 * the caller before its optimistic change) via `restoreItemUntracked` — see
 * this file's top-of-file architecture note for why that's scoped to a
 * single item rather than the whole list. Same 401/403-defers-to-interceptor
 * handling as `useCreateObject` above.
 */
export function useUpdateObject(floorPlanId: number = DEFAULT_FLOOR_PLAN_ID) {
  const queryClient = useQueryClient()
  const { showError } = useToast()

  return useMutation({
    mutationKey: ['objects', floorPlanId],
    mutationFn: async (variables: UpdateObjectVariables) => {
      const { data } = await apiClient.patch<CanvasObject>(`/objects/${variables.id}/`, variables.patch)
      return data
    },
    onError: (error, variables) => {
      useCanvasStore.getState().restoreItemUntracked(variables.previous)
      if (!isAuthError(error)) {
        showError("Couldn't save that change. It's been reverted.")
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['objects', floorPlanId] })
    },
  })
}

/**
 * `DELETE /api/objects/<id>/` — backs U8's Delete/Backspace shortcut (and,
 * via undo/redo diffing, a redo of a delete or undo of a create).
 *
 * `onError` re-adds the removed item via `restoreItemUntracked` (same
 * per-item scoping rationale as `useUpdateObject`). Same 401/403 handling.
 */
export function useDeleteObject(floorPlanId: number = DEFAULT_FLOOR_PLAN_ID) {
  const queryClient = useQueryClient()
  const { showError } = useToast()

  return useMutation({
    mutationKey: ['objects', floorPlanId],
    mutationFn: async (variables: DeleteObjectVariables) => {
      await apiClient.delete(`/objects/${variables.id}/`)
    },
    onError: (error, variables) => {
      useCanvasStore.getState().restoreItemUntracked(variables.previous)
      if (!isAuthError(error)) {
        showError("Couldn't delete that item. It's been restored.")
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['objects', floorPlanId] })
    },
  })
}

export interface ObjectPersistence {
  createObject: (item: CanvasObject) => void
  updateObject: (id: CanvasObject['id'], patch: Record<string, unknown>, previous: CanvasObject) => void
  deleteObject: (id: CanvasObject['id'], previous: CanvasObject) => void
}

/**
 * Wires all three mutations above into a single `ObjectPersistence` handle,
 * AND registers that same handle as `canvasStore.ts`'s module-level
 * `PersistenceDispatcher` (see that file's doc comment) for the duration
 * this hook is mounted — which is exactly the lifetime of `CanvasEditorPage`
 * (the only place this hook is called), so undo/redo (`Toolbar.tsx` ->
 * `canvasStore.ts`'s `undo()`/`redo()`) always has a live dispatcher to
 * call into whenever the canvas is actually on screen.
 *
 * Returns the same handle for `CanvasEditorPage.tsx`'s own event handlers
 * to call directly (create-on-drop, update-on-dragend/transformend/
 * z-reorder/line-anchor-dragend, delete-on-Backspace) — one hook, one
 * source of truth for "how do I persist a change," used identically by
 * direct user interactions and by undo/redo.
 */
export function useObjectPersistence(floorPlanId: number = DEFAULT_FLOOR_PLAN_ID): ObjectPersistence {
  const createMutation = useCreateObject(floorPlanId)
  const updateMutation = useUpdateObject(floorPlanId)
  const deleteMutation = useDeleteObject(floorPlanId)

  const persistence = useMemo<ObjectPersistence>(
    () => ({
      createObject: (item) => createMutation.mutate({ localId: item.id, payload: toCreatePayload(item) }),
      updateObject: (id, patch, previous) => updateMutation.mutate({ id, patch, previous }),
      deleteObject: (id, previous) => deleteMutation.mutate({ id, previous }),
    }),
    // `mutate` is TanStack Query's stable bound-to-the-observer function, so
    // depending on just the three `.mutate` references (not the whole
    // mutation result objects, which include e.g. `isPending`/`data` that
    // change on every mutation lifecycle event) is deliberate — including
    // the full objects would recompute `persistence` far more often than
    // needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [createMutation.mutate, updateMutation.mutate, deleteMutation.mutate],
  )

  useEffect(() => {
    registerPersistenceDispatcher(persistence)
    return () => registerPersistenceDispatcher(null)
  }, [persistence])

  return persistence
}

/**
 * True while any create/update/delete mutation for this floor plan is still
 * in flight — matches by the shared `mutationKey` prefix all three
 * mutations above use.
 *
 * `CanvasEditorPage.tsx`'s `objectsQuery.data -> setItems()` resync effect
 * gates on this (code-review finding, fixed): every mutation's `onSettled`
 * invalidates the SAME `['objects', floorPlanId]` query key, so one
 * mutation settling triggers a refetch whose response reflects server
 * state for every OTHER item too — including one still mid-flight from a
 * second, concurrent mutation. Resyncing unconditionally would transiently
 * overwrite that second item's optimistic change with stale server data
 * until its own mutation resolves a moment later (self-healing, but a real,
 * visible flicker). Deferring the resync until nothing is mutating means
 * the eventual resync always reflects a moment where every optimistic
 * change already has a settled outcome.
 */
export function useIsObjectsMutating(floorPlanId: number = DEFAULT_FLOOR_PLAN_ID): boolean {
  return useIsMutating({ mutationKey: ['objects', floorPlanId] }) > 0
}
