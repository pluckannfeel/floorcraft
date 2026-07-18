import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AxiosError } from 'axios'
import { apiClient } from '../api/client'
import type { CatalogType } from '../canvas/types'
import { useToast } from '../notifications/ToastContext'

/**
 * U5 (object-visuals): the personal variant catalog's data layer — one plain
 * TanStack Query list plus upload/delete mutations against
 * `/api/object-variants/` (backend/fm_generator/urls.py registers the
 * ObjectVariantViewSet; U2 owns list/create/soft-delete, U3 the file route).
 *
 * Architecture stance (institutional learnings, both cited by the plan):
 * - The catalog stays a PLAIN query resource — never mirrored into the
 *   zustand store or its zundo `partialize`
 *   (docs/solutions/ui-bugs/undo-redo-broken-after-save-2026-07-16.md).
 * - Mutations merge their result into the query cache via `setQueryData`,
 *   never invalidate-and-refetch — the repo convention `useSaveObjects`
 *   established, whose safest reading of the superseded resync learning
 *   (docs/solutions/logic-errors/tanstack-query-cross-mutation-resync-
 *   flicker-2026-07-16.md) is: no store mirror, no optimistic writes, and no
 *   background refetch racing whatever the user is doing. The server's echo
 *   of the created row (id, recorded dimensions, file_url) is authoritative,
 *   so the merge needs no reconciliation pass.
 */

/** One row of `GET /api/object-variants/` — the ObjectVariantSerializer's
 * read shape (`file` itself is write-only server-side; consumers stream the
 * bytes through the authenticated `file_url` instead). `width`/`height` are
 * the pipeline-recorded NATURAL dimensions — U6's aspect-fit drop math reads
 * them, which is why the drag payload carries them (R8). `original_name` is
 * display-only (R12: file-derived names for tooltips/aria). */
export interface ObjectVariant {
  id: number
  object_type: CatalogType
  width: number
  height: number
  size_bytes: number
  original_name: string
  created_at: string
  file_url: string
}

/** Single user-scoped key (variants are personal and cross-plan, R8 — no
 * per-plan segmentation). Exported so tests and future consumers address
 * the same cache entry the mutations below merge into. */
export const VARIANTS_QUERY_KEY = ['objectVariants'] as const

// ---------------------------------------------------------------------------
// Client-side upload pre-check (U5; AE2 client half)
//
// Mirrors the server pipeline's cheap outer layers — extension allowlist and
// per-format byte caps — so a hopeless upload is rejected BEFORE any request:
// the plan's three-times-deliberately stance (client pre-check guarantees the
// friendly message regardless of proxy behavior; the serializer stays
// authoritative; nginx is only the transport ceiling). Values and message
// wording deliberately mirror backend/fm_generator/variants.py
// (MAX_RASTER_BYTES / MAX_SVG_BYTES / MSG_*) so the user reads the same
// explanation whether the client or the server caught it (R9).
// ---------------------------------------------------------------------------

export const UPLOAD_EXTENSION_ALLOWLIST = ['svg', 'png', 'jpg', 'jpeg'] as const
export const MAX_RASTER_UPLOAD_BYTES = 5 * 1024 * 1024 // 5 MB — PNG/JPEG
export const MAX_SVG_UPLOAD_BYTES = 1 * 1024 * 1024 // 1 MB — SVG

export const UPLOAD_BAD_EXTENSION_MESSAGE =
  'Unsupported file type. Please upload an SVG, PNG, or JPEG image (.svg, .png, .jpg, or .jpeg).'
export const UPLOAD_RASTER_TOO_BIG_MESSAGE =
  'That image is too large. PNG and JPEG uploads are limited to 5 MB.'
export const UPLOAD_SVG_TOO_BIG_MESSAGE =
  'That SVG is too large. SVG uploads are limited to 1 MB.'

/**
 * Returns the friendly rejection message for a file the server would refuse
 * on extension or size grounds, or `null` when the file is worth posting.
 * Pure (takes only what it reads) so the reject matrix is testable without
 * constructing real multi-megabyte Files.
 */
export function clientUploadRejection(file: Pick<File, 'name' | 'size'>): string | null {
  const dotIndex = file.name.lastIndexOf('.')
  const extension = dotIndex === -1 ? '' : file.name.slice(dotIndex + 1).toLowerCase()
  if (!(UPLOAD_EXTENSION_ALLOWLIST as readonly string[]).includes(extension)) {
    return UPLOAD_BAD_EXTENSION_MESSAGE
  }
  if (extension === 'svg') {
    return file.size > MAX_SVG_UPLOAD_BYTES ? UPLOAD_SVG_TOO_BIG_MESSAGE : null
  }
  return file.size > MAX_RASTER_UPLOAD_BYTES ? UPLOAD_RASTER_TOO_BIG_MESSAGE : null
}

// ---------------------------------------------------------------------------
// Error surfacing
// ---------------------------------------------------------------------------

/** Same guard as useObjects.ts: 401/403 are owned by the global axios
 * interceptor's redirect-to-login (R30), so mutation-level toasts skip them.
 * The plan's Risks table calls the 403 case out explicitly for THIS feature:
 * a CSRF-rotation 403 mid-upload bounces to login (accepted pre-existing app
 * behavior) — the friendly-message contract below covers 400s only, and
 * nothing here may intercept a 403. */
function isAuthError(error: unknown): boolean {
  const status = (error as AxiosError | undefined)?.response?.status
  return status === 401 || status === 403
}

/**
 * Extracts the serializer's specific human-readable rejection from a 400
 * response — DRF field-error shape, e.g. `{"file": ["That SVG is too
 * large…"]}` (U2's VariantRejected → ValidationError on the `file` field;
 * quota rejections ride the same field, `object_type` errors their own).
 * The first message found is THE message (the pipeline raises exactly one).
 * Anything that isn't a 400 with that shape returns null and falls back to
 * the generic toast — deliberately including 429 throttle responses.
 */
function server400Detail(error: unknown): string | null {
  const response = (error as AxiosError | undefined)?.response
  if (response?.status !== 400) return null
  const data = response.data
  if (data == null || typeof data !== 'object') return null
  for (const value of Object.values(data)) {
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  }
  return null
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * The user's active variants (R6–R8): one flat list, grouped by
 * `object_type` at the call site (Sidebar) — the server already scopes to
 * the caller and hides soft-deleted rows (list filters `is_active`; R11's
 * soft-delete keeps serving FILES, not catalog entries). No error toast on
 * the query itself, matching `useObjects`' read-only convention — the
 * Sidebar degrades gracefully instead (defaults have zero network
 * dependency).
 */
export function useVariants() {
  return useQuery({
    queryKey: VARIANTS_QUERY_KEY,
    queryFn: async () => {
      const { data } = await apiClient.get<ObjectVariant[]>('/object-variants/')
      return data
    },
  })
}

/**
 * F1 (upload a variant): multipart POST of `{object_type, file}`. On
 * success the server's echo of the created row is APPENDED into the query
 * cache via `setQueryData` — never invalidate-and-refetch (see module doc;
 * the superseded resync learning's no-refetch stance), so the new thumbnail
 * appears under its type immediately with zero extra requests (AE2).
 *
 * On error: toast per the `useSaveObjects` convention — the serializer's
 * specific 400 message when there is one (format vs size vs active-content
 * vs quota, R9/R19), a generic retry line otherwise; 401/403 stay silent
 * (interceptor-owned, see isAuthError).
 */
export function useUploadVariant() {
  const queryClient = useQueryClient()
  const { showError } = useToast()

  return useMutation({
    mutationFn: async ({ objectType, file }: { objectType: CatalogType; file: File }) => {
      const form = new FormData()
      form.append('object_type', objectType)
      form.append('file', file)
      const { data } = await apiClient.post<ObjectVariant>('/object-variants/', form)
      return data
    },
    onSuccess: (created) => {
      queryClient.setQueryData<ObjectVariant[]>(VARIANTS_QUERY_KEY, (existing) =>
        existing ? [...existing, created] : [created],
      )
    },
    onError: (error) => {
      if (isAuthError(error)) return
      showError(server400Detail(error) ?? "Couldn't upload your image. Please try again.")
    },
  })
}

/**
 * F3 (delete a variant): DELETE soft-deletes server-side (idempotent; the
 * row and file survive so placed objects keep rendering — R11/R18), and on
 * success the variant is FILTERED out of the query cache via `setQueryData`
 * — same never-refetch convention as the upload merge. The confirm dialog
 * gating this call is the Sidebar's job (R18's exact copy lives there).
 */
export function useDeleteVariant() {
  const queryClient = useQueryClient()
  const { showError } = useToast()

  return useMutation({
    mutationFn: async (variantId: number) => {
      await apiClient.delete(`/object-variants/${variantId}/`)
      return variantId
    },
    onSuccess: (variantId) => {
      queryClient.setQueryData<ObjectVariant[]>(VARIANTS_QUERY_KEY, (existing) =>
        existing?.filter((variant) => variant.id !== variantId),
      )
    },
    onError: (error) => {
      if (isAuthError(error)) return
      showError(server400Detail(error) ?? "Couldn't remove that upload. Please try again.")
    },
  })
}
