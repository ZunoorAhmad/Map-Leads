import type { ScrapedGoogleMapsData } from '../types'

const defaultApiUrl = import.meta.env.VITE_API_URL?.trim() ?? ''

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
    throw new Error(
      body
        ? `API request failed with ${response.status}: ${body}`
        : `API request failed with ${response.status}`,
    )
  }

  return response
}