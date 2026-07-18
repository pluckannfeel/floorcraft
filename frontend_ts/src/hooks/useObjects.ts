import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AxiosError } from 'axios'
import { apiClient } from '../api/client'
import { useCanvasStore } from '../state/canvasStore'
import type { CanvasObject, FloorPlan } from '../canvas/types'
import { useToast } from '../notifications/ToastContext'

/**
 * Read-only query for a FloorPlan's Objects: `GET /api/objects/?floor_plan=<id>`
 * (backend/fm_generator/urls.py registers `objects` on the DRF router;
 * `ObjectViewSet.get_queryset` filters on the `floor_plan` query param).
 *
 * `['objects', floorPlanId]` is the same query key `useSaveObjects` below
 * writes the save response into, so the cache always mirrors the last
 * server-confirmed list.
 */
export function useObjects(floorPlanId: number) {
  return useQuery({
    queryKey: ['objects', floorPlanId],
    queryFn: async () => {
      const { data } = await apiClient.get<CanvasObject[]>('/objects/', {
        params: { floor_plan: floorPlanId },
      })
      return data
    },
    // U5: `floorPlanId` comes from the `/floor-plans/:floorPlanId` route
    // param. A malformed param (`NaN` after `Number(...)`) or non-positive
    // id can never match a backend row — don't fire a garbage request for
    // it (`CanvasEditorPage` renders its not-found state instead).
    enabled: Number.isInteger(floorPlanId) && floorPlanId > 0,
  })
}

/**
 * Explicit-save architecture note (this file + `canvasStore.ts` +
 * `CanvasEditorPage.tsx`):
 *
 * The canvas is fully local-first — the Zustand `canvasStore`'s `items`
 * array is what's rendered, moved, and undo/redo-tracked, seeded once from
 * the query above. Edits accumulate locally (the store's `dirty` flag
 * tracks the divergence) and NOTHING persists per action; the one and only
 * write path is `useSaveObjects` below, fired explicitly by the user (Save
 * button / Ctrl+S). Sending the store's full `items` list IS the sync:
 * id-less entries are creates, id-carrying entries are updates, and
 * anything the server has that the payload omits gets deleted server-side —
 * so a single PUT reconciles every local create/move/delete/property edit
 * (and any undo/redo net effect) at once, with no per-item diffing needed
 * on the client.
 */

function isAuthError(error: unknown): boolean {
  const status = (error as AxiosError | undefined)?.response?.status
  return status === 401 || status === 403
}

/**
 * Builds one entry of the PUT body's `objects` array from a store item —
 * the ObjectSerializer's writable fields, with:
 * - `floor_plan` stripped (the URL already scopes the request to one plan);
 * - server-owned timestamps stripped;
 * - `id` translated through the store's `serverIdMap`: an item's
 *   client-side id never changes within a session (that's what keeps undo
 *   history valid across saves), so the map re-points it at whatever row
 *   the server last created for it. Unmapped local ids go out as-is (the
 *   server treats any unmatched id as a create and reports the new row in
 *   `id_map`); unmapped numeric ids are rows loaded from the server.
 */
function toSaveObjectPayload(
  item: CanvasObject,
  serverIdMap: Record<string, number>,
): Record<string, unknown> {
  return {
    id: serverIdMap[String(item.id)] ?? item.id,
    type: item.type,
    name: item.name,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    rotation: item.rotation,
    z_index: item.z_index,
    properties: item.properties,
    // U4: always sent explicitly (null when the item was never grouped, or
    // carries no key) so an ungroup round-trips as a CLEAR server-side —
    // omitting the field on an update would silently keep the old key.
    group_key: item.group_key ?? null,
  }
}

/** The sync endpoint's response envelope (see FloorPlanViewSet.sync_objects). */
interface SaveObjectsResponse {
  objects: CanvasObject[]
  id_map: Record<string, number>
}

/**
 * `PUT /api/floor-plans/<id>/objects/` — the explicit save. Reads the
 * store's current `items` at mutate time (not hook-render time, so the
 * payload always reflects the moment the user hit Save) and sends the full
 * list with ids translated through `serverIdMap`; the 200 response is
 * `{ objects, id_map }` where `objects` is the canonical list (same item
 * shape as the GET above) and `id_map` maps every sent-but-created id to
 * its real new row id.
 *
 * U8 (canvas-tools): the PUT also ALWAYS carries the store's live canvas
 * dims as `canvas: {width, height}` — not only after a crop. A
 * diverged-from-baseline check would need baseline bookkeeping and invites
 * silent client/server dims drift; always-send is idempotent and
 * self-healing (the server field stays optional purely for backward
 * compatibility). The field is skipped only when `canvasSize` is null (the
 * pre-seed edge — a save can't fire from the unrendered editor, but the
 * hook must not fabricate dims if it somehow does).
 *
 * On success — deliberately WITHOUT touching `items` or the undo history
 * (the fix for "undo/redo doesn't work after saving"):
 * - `mergeServerIdMap(id_map)` re-points the affected client ids at their
 *   new rows, so the NEXT save's payload translation stays correct even
 *   for items that were created (or deleted-then-redone) across saves.
 * - `markSaved()` clears `dirty` — but only when NEITHER `items` NOR
 *   `canvasSize` (U8) changed since the payload was captured; if the user
 *   kept editing (or cropped again) while the PUT was in flight, those
 *   edits are still unsaved and the flag must stay.
 * - The canonical list is written into the query cache (`setQueryData`,
 *   not invalidate-and-refetch): the cache backs the initial seed of
 *   future editor mounts, and a background refetch here could race a user
 *   already editing again. U8: the `['floorPlan', id]` cache gets the
 *   saved dims merged in the same way (the useRenameFloorPlan pattern), so
 *   a later remount seeds the persisted dims without a refetch.
 *
 * On error: toast (except 401/403, where the global axios interceptor's
 * redirect-to-login already owns the messaging — R30) and nothing else:
 * the local items stay exactly as they are, still dirty, so the user can
 * simply retry.
 */
export function useSaveObjects(floorPlanId: number) {
  const queryClient = useQueryClient()
  const { showError } = useToast()

  return useMutation({
    mutationFn: async () => {
      const { items, serverIdMap, canvasSize } = useCanvasStore.getState()
      const { data } = await apiClient.put<SaveObjectsResponse>(
        `/floor-plans/${floorPlanId}/objects/`,
        {
          objects: items.map((item) => toSaveObjectPayload(item, serverIdMap)),
          ...(canvasSize
            ? { canvas: { width: canvasSize.width, height: canvasSize.height } }
            : {}),
        },
      )
      return { ...data, sentItems: items, sentCanvasSize: canvasSize }
    },
    onSuccess: ({ objects, id_map, sentItems, sentCanvasSize }) => {
      const store = useCanvasStore.getState()
      store.mergeServerIdMap(id_map)
      // Edits made while the PUT was in flight replaced the `items` array
      // reference (or, U8, the `canvasSize` reference — another crop) and
      // are NOT covered by this save — leave `dirty` alone for those;
      // otherwise the canvas now matches the server.
      const current = useCanvasStore.getState()
      if (current.items === sentItems && current.canvasSize === sentCanvasSize) {
        store.markSaved()
      }
      queryClient.setQueryData(['objects', floorPlanId], objects)
      // U8: the saved dims are now the server truth — merge them into the
      // floor-plan cache entry (like useRenameFloorPlan's name merge) so
      // future seeds/readers see them without a refetch. Merge-only: if
      // nothing is cached there's nothing stale to fix.
      if (sentCanvasSize) {
        queryClient.setQueryData<FloorPlan>(['floorPlan', floorPlanId], (existing) =>
          existing
            ? {
                ...existing,
                canvas_width: sentCanvasSize.width,
                canvas_height: sentCanvasSize.height,
              }
            : existing,
        )
      }
    },
    onError: (error) => {
      if (!isAuthError(error)) {
        showError("Couldn't save your changes. Please try again.")
      }
    },
  })
}
