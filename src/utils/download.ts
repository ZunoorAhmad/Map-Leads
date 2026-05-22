import type { ScrapedGoogleMapsData } from '../types'

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function downloadJson(
  data: ScrapedGoogleMapsData | ScrapedGoogleMapsData[],
  search: string = '',
) {
  const filename = `google-maps-data-${buildTimestamp()}.json`
  const payload = { search, data }
  const json = JSON.stringify(payload, null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = objectUrl
  link.download = filename
  link.style.display = 'none'

  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)

  return filename
}