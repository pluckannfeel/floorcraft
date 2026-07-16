import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AxiosError } from 'axios'
import { apiClient } from '../api/client'
import type { FloorPlan } from '../canvas/types'
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
