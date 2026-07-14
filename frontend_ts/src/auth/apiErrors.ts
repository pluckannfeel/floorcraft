import axios from 'axios'

/**
 * Shape of error response bodies returned by the accounts API: either a
 * single `detail` message (generic/non-field errors, e.g. login) or a map
 * of field name -> list of validation messages (DRF serializer errors,
 * e.g. registration).
 */
export interface ApiErrorData {
  detail?: string
  [field: string]: string[] | string | undefined
}

export function getApiErrorData(error: unknown): ApiErrorData | undefined {
  if (axios.isAxiosError(error)) {
    return error.response?.data as ApiErrorData | undefined
  }
  return undefined
}

/** A single flat list of human-readable messages, field errors first. */
export function flattenApiErrors(error: unknown, fallback: string): string[] {
  const data = getApiErrorData(error)
  if (!data) return [fallback]

  const messages: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (key === 'detail') continue
    if (Array.isArray(value)) messages.push(...value)
    else if (typeof value === 'string') messages.push(value)
  }
  if (data.detail) messages.push(data.detail)

  return messages.length > 0 ? messages : [fallback]
}
