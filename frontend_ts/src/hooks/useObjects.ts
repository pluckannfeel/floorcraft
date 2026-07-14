import { useQuery } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import type { CanvasObject } from '../canvas/types'
import { DEFAULT_FLOOR_PLAN_ID } from '../canvas/types'

/**
 * Read-only query for a FloorPlan's Objects: `GET /api/objects/?floor_plan=<id>`
 * (backend/fm_generator/urls.py registers `objects` on the DRF router;
 * `ObjectViewSet.get_queryset` filters on the `floor_plan` query param).
 *
 * Mutations (create/update/delete persistence) are added in U13 — this unit
 * only needs the initial read to populate the canvas on load.
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
