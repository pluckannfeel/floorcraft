import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { apiClient } from '../api/client'
import * as ToastContextModule from '../notifications/ToastContext'
import {
  MAX_RASTER_UPLOAD_BYTES,
  MAX_SVG_UPLOAD_BYTES,
  UPLOAD_BAD_EXTENSION_MESSAGE,
  UPLOAD_RASTER_TOO_BIG_MESSAGE,
  UPLOAD_SVG_TOO_BIG_MESSAGE,
  VARIANTS_QUERY_KEY,
  clientUploadRejection,
  useDeleteVariant,
  useUploadVariant,
  useVariants,
  type ObjectVariant,
} from './useVariants'

/**
 * U5 (object-visuals): the variant catalog data layer. Same conventions as
 * useObjects.test.tsx — `apiClient` mocked via `vi.spyOn`, `useToast`
 * mocked so no ToastProvider is needed, QueryClientProvider wrapper with
 * retries off.
 *
 * The on-success contract under test is the repo's merge-never-refetch
 * convention (setQueryData; the superseded resync learning's safest
 * reading): upload APPENDS the server echo into the cache and delete
 * FILTERS it out — neither ever triggers a second GET.
 */

function makeVariant(overrides: Partial<ObjectVariant> = {}): ObjectVariant {
  return {
    id: 1,
    object_type: 'chairs',
    width: 300,
    height: 150,
    size_bytes: 1234,
    original_name: 'my-chair.png',
    created_at: '2026-07-18T00:00:00Z',
    file_url: '/api/object-variants/1/file/',
    ...overrides,
  }
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

const showError = vi.fn()

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  showError.mockClear()
  vi.spyOn(ToastContextModule, 'useToast').mockReturnValue({
    toasts: [],
    showError,
    dismiss: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useVariants (list query)', () => {
  it('fetches the personal variant list from /object-variants/', async () => {
    const variants = [makeVariant(), makeVariant({ id: 2, object_type: 'tables' })]
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: variants } as never)

    const { result } = renderHook(() => useVariants(), { wrapper })

    await waitFor(() => expect(result.current.data).toEqual(variants))
    expect(getSpy).toHaveBeenCalledWith('/object-variants/')
  })
})

describe('useUploadVariant', () => {
  it('POSTs multipart {object_type, file} and MERGES the echo into the cache without a refetch', async () => {
    const existing = makeVariant({ id: 1 })
    const created = makeVariant({ id: 2, original_name: 'sofa.png' })
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: [existing] } as never)
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: created } as never)

    // List + upload mounted together, like the Sidebar does: the merge must
    // land in the SAME cache entry the list renders from.
    const { result } = renderHook(() => ({ list: useVariants(), upload: useUploadVariant() }), {
      wrapper,
    })
    await waitFor(() => expect(result.current.list.data).toEqual([existing]))

    const file = new File(['png-bytes'], 'sofa.png', { type: 'image/png' })
    act(() => result.current.upload.mutate({ objectType: 'chairs', file }))
    await waitFor(() => expect(result.current.upload.isSuccess).toBe(true))

    // Multipart body: FormData carrying exactly the two create fields the
    // serializer accepts (everything else is pipeline-derived server-side).
    const [url, body] = postSpy.mock.calls[0] as [string, FormData]
    expect(url).toBe('/object-variants/')
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('object_type')).toBe('chairs')
    expect(body.get('file')).toBe(file)

    // The convention under test: setQueryData append — the new variant is
    // in the cache (and thus the strip) with NO second GET fired.
    expect(queryClient.getQueryData(VARIANTS_QUERY_KEY)).toEqual([existing, created])
    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it("surfaces the serializer's specific 400 detail ({file: [...]}) in the toast", async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: { file: ['That SVG is too large. SVG uploads are limited to 1 MB.'] },
      },
    })

    const { result } = renderHook(() => useUploadVariant(), { wrapper })
    act(() =>
      result.current.mutate({ objectType: 'chairs', file: new File(['x'], 'big.svg') }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(showError).toHaveBeenCalledWith(
      'That SVG is too large. SVG uploads are limited to 1 MB.',
    )
  })

  it('toasts the generic message on a network/server failure', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const { result } = renderHook(() => useUploadVariant(), { wrapper })
    act(() =>
      result.current.mutate({ objectType: 'tables', file: new File(['x'], 'table.png') }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(showError).toHaveBeenCalledWith("Couldn't upload your image. Please try again.")
  })

  it('stays silent on 401/403 — the auth interceptor owns those (plan Risks: 403-vs-400)', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { detail: 'CSRF Failed' } },
    })

    const { result } = renderHook(() => useUploadVariant(), { wrapper })
    act(() =>
      result.current.mutate({ objectType: 'doors', file: new File(['x'], 'door.png') }),
    )
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(showError).not.toHaveBeenCalled()
  })
})

describe('useDeleteVariant', () => {
  it('DELETEs the variant and FILTERS it out of the cache without a refetch', async () => {
    const keep = makeVariant({ id: 2, original_name: 'keep.png' })
    const gone = makeVariant({ id: 1 })
    queryClient.setQueryData(VARIANTS_QUERY_KEY, [gone, keep])
    const getSpy = vi.spyOn(apiClient, 'get')
    const deleteSpy = vi.spyOn(apiClient, 'delete').mockResolvedValue({} as never)

    const { result } = renderHook(() => useDeleteVariant(), { wrapper })
    act(() => result.current.mutate(1))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(deleteSpy).toHaveBeenCalledWith('/object-variants/1/')
    expect(queryClient.getQueryData(VARIANTS_QUERY_KEY)).toEqual([keep])
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('toasts on failure and leaves the cache intact', async () => {
    const variants = [makeVariant()]
    queryClient.setQueryData(VARIANTS_QUERY_KEY, variants)
    vi.spyOn(apiClient, 'delete').mockRejectedValue({
      isAxiosError: true,
      response: { status: 500, data: {} },
    })

    const { result } = renderHook(() => useDeleteVariant(), { wrapper })
    act(() => result.current.mutate(1))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(showError).toHaveBeenCalledWith("Couldn't remove that upload. Please try again.")
    expect(queryClient.getQueryData(VARIANTS_QUERY_KEY)).toEqual(variants)
  })

  it('stays silent on auth failures (interceptor-owned)', async () => {
    vi.spyOn(apiClient, 'delete').mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: {} },
    })

    const { result } = renderHook(() => useDeleteVariant(), { wrapper })
    act(() => result.current.mutate(1))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(showError).not.toHaveBeenCalled()
  })
})

describe('clientUploadRejection (AE2 client half — pre-check before any request)', () => {
  it('accepts every allowlisted extension, case-insensitively', () => {
    for (const name of ['a.svg', 'b.png', 'c.jpg', 'd.jpeg', 'PHOTO.JPG', 'Chair.PnG']) {
      expect(clientUploadRejection({ name, size: 1000 }), name).toBeNull()
    }
  })

  it('rejects wrong/missing extensions with the friendly format message', () => {
    for (const name of ['notes.txt', 'archive.zip', 'noextension', 'image.png.exe']) {
      expect(clientUploadRejection({ name, size: 1000 }), name).toBe(
        UPLOAD_BAD_EXTENSION_MESSAGE,
      )
    }
  })

  it('enforces the 5 MB raster cap (boundary-exact, mirroring the serializer)', () => {
    expect(
      clientUploadRejection({ name: 'big.png', size: MAX_RASTER_UPLOAD_BYTES }),
    ).toBeNull()
    expect(clientUploadRejection({ name: 'big.png', size: MAX_RASTER_UPLOAD_BYTES + 1 })).toBe(
      UPLOAD_RASTER_TOO_BIG_MESSAGE,
    )
  })

  it('enforces the 1 MB SVG cap — an SVG within the raster cap is still too big', () => {
    expect(clientUploadRejection({ name: 'ok.svg', size: MAX_SVG_UPLOAD_BYTES })).toBeNull()
    expect(clientUploadRejection({ name: 'big.svg', size: MAX_SVG_UPLOAD_BYTES + 1 })).toBe(
      UPLOAD_SVG_TOO_BIG_MESSAGE,
    )
    // 2 MB: fine for a PNG, over the SVG cap — the per-format branch matters.
    expect(clientUploadRejection({ name: 'big.svg', size: 2 * 1024 * 1024 })).toBe(
      UPLOAD_SVG_TOO_BIG_MESSAGE,
    )
  })
})
