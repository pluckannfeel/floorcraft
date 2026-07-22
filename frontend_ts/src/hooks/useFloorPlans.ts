import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AxiosError } from 'axios'
import { apiClient } from '../api/client'
import type { FloorPlan } from '../canvas/types'
import type { Unit } from '../canvas/rulers'
import { useToast } from '../notifications/ToastContext'

/**
 * U4/R13: the name every "Create new" floor plan starts with (the
 * untitled-and-navigate decision — no name prompt; the user renames inline
 * in the editor afterwards, U6). Kept as one exported constant so the
 * dashboard's create payload and the editor's rename placeholder (U6) can't
 * drift apart.
 */
export const DEFAULT_FLOOR_PLAN_NAME = 'Untitled Canvas'

/**
 * `GET /api/floor-plans/` — lists the requesting user's floor plans only
 * (U2 scoped `FloorPlanViewSet.get_queryset()` to `request.user`, so no
 * client-side filtering is needed here).
 */
export function useFloorPlans() {
  return useQuery({
    queryKey: ['floorPlans'],
    queryFn: async () => {
      const { data } = await apiClient.get<FloorPlan[]>('/floor-plans/')
      return data
    },
  })
}

// Same convention as useObjects.ts: 401/403 is already handled by the global
// axios interceptor (redirect to login), so mutation onError skips the
// generic toast for auth failures specifically.
function isAuthError(error: unknown): boolean {
  const status = (error as AxiosError | undefined)?.response?.status
  return status === 401 || status === 403
}

/**
 * `POST /api/floor-plans/` with the default payload (R5/R13). Only `name`
 * is required by `FloorPlanSerializer` — `grid_size`/`canvas_width`/
 * `canvas_height` have model defaults (20/1600/1200), which DRF's
 * ModelSerializer therefore marks `required=False`, so they're omitted.
 * `owner` is set server-side via `perform_create` (U2), never sent.
 *
 * Navigation on success is the CALLER's job (the dashboard passes an
 * `onSuccess` to `mutate`) — on failure the user stays on the dashboard
 * with an error toast, per the existing useObjects.ts toast convention.
 */
export function useCreateFloorPlan() {
  const queryClient = useQueryClient()
  const { showError } = useToast()

  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<FloorPlan>('/floor-plans/', {
        name: DEFAULT_FLOOR_PLAN_NAME,
      })
      return data
    },
    onError: (error) => {
      if (!isAuthError(error)) {
        showError("Couldn't create a new floor plan. Please try again.")
      }
    },
    onSettled: () => {
      // Keeps the dashboard list fresh if the user navigates back to it
      // after (or despite) the create.
      queryClient.invalidateQueries({ queryKey: ['floorPlans'] })
    },
  })
}

/**
 * U6/R13: `PATCH /api/floor-plans/<id>/` with `{ name }` — backs the
 * editor's inline rename (`FloorPlanNameEditor`). Nothing is written
 * optimistically: on success the `['floorPlan', id]` cache is updated in
 * place (so the editor's label reflects the new name immediately, no
 * refetch) and the `['floorPlans']` dashboard list is invalidated so it
 * shows the new name too; on failure the cache was never touched, so the
 * label naturally reverts to the previous name, plus the standard error
 * toast (401/403 excepted — the global interceptor owns those, same
 * convention as useCreateFloorPlan above).
 */
export function useRenameFloorPlan(floorPlanId: number) {
  const queryClient = useQueryClient()
  const { showError } = useToast()

  return useMutation({
    mutationFn: async ({ name }: { name: string }) => {
      const { data } = await apiClient.patch<FloorPlan>(`/floor-plans/${floorPlanId}/`, { name })
      return data
    },
    onSuccess: (updated) => {
      // Merge rather than replace, so any extra fields a cached GET payload
      // carries beyond the `FloorPlan` type survive the PATCH response.
      queryClient.setQueryData<FloorPlan>(['floorPlan', floorPlanId], (current) =>
        current ? { ...current, ...updated } : updated,
      )
      queryClient.invalidateQueries({ queryKey: ['floorPlans'] })
    },
    onError: (error) => {
      if (!isAuthError(error)) {
        showError("Couldn't rename the floor plan. The previous name was kept.")
      }
    },
  })
}

/** The scale/unit fields a settings PATCH may carry (both optional so the
 * unit selector and the scale input can each PATCH just their own field).
 * `real_size_per_grid_square` is CANONICAL METERS (U1); `unit` is display-
 * only, so switching it re-labels the same physical size, never rescales. */
export interface FloorPlanSettingsPatch {
  real_size_per_grid_square?: number
  unit?: Unit
}

/**
 * U4/R1-R4: `PATCH /api/floor-plans/<id>/` with `{ real_size_per_grid_square?,
 * unit? }` — backs the editor header's scale/unit control. The exact
 * not-optimistic, cache-merge shape as `useRenameFloorPlan`: on success the
 * `['floorPlan', id]` cache is merged in place, so `CanvasEditorPage`
 * re-renders with the new scale/unit and the ruler overlay (U3) relabels
 * live (R4/AE2) with no refetch and no canvas save; the `['floorPlans']`
 * dashboard list is invalidated. On failure the cache was never touched, so
 * the control reverts to the persisted values, plus the standard error toast
 * (401/403 owned by the global interceptor, same as the siblings above).
 */
export function useUpdateFloorPlanSettings(floorPlanId: number) {
  const queryClient = useQueryClient()
  const { showError } = useToast()

  return useMutation({
    mutationFn: async (patch: FloorPlanSettingsPatch) => {
      const { data } = await apiClient.patch<FloorPlan>(`/floor-plans/${floorPlanId}/`, patch)
      return data
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<FloorPlan>(['floorPlan', floorPlanId], (current) =>
        current ? { ...current, ...updated } : updated,
      )
      queryClient.invalidateQueries({ queryKey: ['floorPlans'] })
    },
    onError: (error) => {
      if (!isAuthError(error)) {
        showError("Couldn't update the scale. The previous setting was kept.")
      }
    },
  })
}
