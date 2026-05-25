import type { ScrapedGoogleMapsData } from '../types'

const defaultApiUrl = import.meta.env.VITE_API_URL?.trim() ?? ''

function formatApiErrorMessage(status: number, body: string) {
  const trimmedBody = body.trim()

  if (!trimmedBody) {
    return `API request failed with ${status}.`
  }

  try {
    const parsed = JSON.parse(trimmedBody) as {
      message?: string
      error?: string
      details?: string
    }

    const apiMessage = parsed.message ?? parsed.error ?? parsed.details ?? ''

    if (apiMessage) {
      return `API request failed with ${status}: ${apiMessage}`
    }
  } catch {
    // Not JSON, fall back to text handling below.
  }

  const compactBody = trimmedBody.replace(/\s+/g, ' ')
  const shortenedBody = compactBody.length > 220 ? `${compactBody.slice(0, 220)}…` : compactBody

  return `API request failed with ${status}: ${shortenedBody}`
}

export async function postScrapedData(
  data: ScrapedGoogleMapsData | ScrapedGoogleMapsData[],
  search: string = '',
  endpoint = defaultApiUrl,
) {
  if (!endpoint) {
    throw new Error('Set VITE_API_URL in your .env file before using Send to API.')
  }

  const payload = { search, data }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(formatApiErrorMessage(response.status, body))
  }

  return response
}