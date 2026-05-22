import { useMemo, useState } from 'react'
import type { ScrapeResponse, ScrapedGoogleMapsData } from '../types'
import { postScrapedData } from '../utils/api'
import { downloadJson } from '../utils/download'
import './popup.css'

type ActionState = 'idle' | 'loading-scrape' | 'loading-download' | 'loading-api'

type StatusState =
  | {
      kind: 'success' | 'error'
      message: string
    }
  | null

type ScrapedArray = ScrapedGoogleMapsData[]

function isGoogleMapsUrl(url?: string) {
  if (!url) {
    return false
  }

  try {
    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname
    const isGoogleMapsHost = hostname === 'google.com' || hostname.endsWith('.google.com')

    return isGoogleMapsHost && parsedUrl.pathname.startsWith('/maps')
  } catch {
    return false
  }
}

function extractSearchFromUrl(url?: string) {
  if (!url) {
    return ''
  }

  try {
    const parsedUrl = new URL(url)
    const pathname = parsedUrl.pathname

    // Pattern: /maps/search/{query} or /maps/search/{query}/{more}
    const match = pathname.match(/\/maps\/search\/([^/@?]+)/)
    if (match && match[1]) {
      const encoded = match[1]
      // Decode URI component and replace + with space
      const decoded = decodeURIComponent(encoded).replace(/\+/g, ' ')
      return decoded
    }
  } catch {}

  return ''
}

function sanitizeLimit(value: string) {
  const trimmed = value.trim()

  if (!trimmed) {
    return null
  }

  const parsed = Number.parseInt(trimmed, 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}



function queryActiveTab() {
  return new Promise<{ id: number; url?: string }>((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0]

      if (!tab?.id) {
        reject(new Error('No active tab was found.'))
        return
      }

      resolve({ id: tab.id, url: tab.url })
    })
  })
}

function requestScrape(tabId: number, limit: number | null) {
  return new Promise<ScrapeResponse>((resolve, reject) => {
    let responded = false
    
    // Set a generous timeout for long-running scrapes (15 minutes max)
    const timeoutId = window.setTimeout(() => {
      if (!responded) {
        responded = true
        reject(new Error('Scraping took too long (15+ minutes). The connection was lost. Try again, keeping the page active and visible.'))
      }
    }, 15 * 60 * 1000)

    chrome.tabs.sendMessage(tabId, { type: 'SCRIPT_START_SCRAPE', limit }, response => {
      if (responded) return
      responded = true
      clearTimeout(timeoutId)

      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message || ''
        if (errorMsg.includes('back/forward cache') || errorMsg.includes('port')) {
          reject(new Error('The page was moved or refreshed before scraping could complete. Make sure the Maps tab stays active during scraping and avoid clicking or navigating. Try again.'))
        } else {
          reject(new Error(errorMsg || 'Content script is not available.'))
        }
        return
      }

      if (!response) {
        reject(new Error('The page did not return any scrape data.'))
        return
      }

      resolve(response)
    })
  })
}

export function Popup() {
  const [actionState, setActionState] = useState<ActionState>('idle')
  const [status, setStatus] = useState<StatusState>(null)
  const [scrapedData, setScrapedData] = useState<ScrapedArray | null>(null)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [limitInput, setLimitInput] = useState<string>('')

  const recordLimit = useMemo(() => sanitizeLimit(limitInput), [limitInput])

  async function startScrape() {
    setStatus(null)
    setActionState('loading-scrape')

    try {
      const activeTab = await queryActiveTab()

      if (!isGoogleMapsUrl(activeTab.url)) {
        throw new Error('Open a Google Maps page before using this extension.')
      }

      // Extract search query from URL for API/download payload
      const search = extractSearchFromUrl(activeTab.url)
      setSearchQuery(search)

      const scrapeResponse = await requestScrape(activeTab.id, recordLimit)

      if (!scrapeResponse.success) {
        throw new Error(scrapeResponse.error)
      }

      // If the response is the all-list form, accept it
      if (Array.isArray((scrapeResponse as any).data)) {
        const rows = (scrapeResponse as any).data as ScrapedArray

        if (!rows || rows.length === 0) {
          throw new Error('The current Google Maps page did not expose any visible business details.')
        }

        setScrapedData(rows)
        setStatus({ kind: 'success', message: `Scraped ${rows.length} results.` })
        return
      }

      // Backwards-compatibility: single object response
      const single = (scrapeResponse as any).data as ScrapedGoogleMapsData
      if (!single) throw new Error('No data returned from scraper.')

      setScrapedData([single])
      setStatus({ kind: 'success', message: 'Scraped 1 result.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.'
      setStatus({ kind: 'error', message })
    } finally {
      setActionState('idle')
    }
  }

  async function runAction(action: 'download' | 'api') {
    setStatus(null)
    setActionState(action === 'download' ? 'loading-download' : 'loading-api')

    try {
      if (!scrapedData || scrapedData.length === 0) throw new Error('No scraped data available.')

      if (action === 'download') {
        const filename = downloadJson(scrapedData, searchQuery)
        setStatus({ kind: 'success', message: `Downloaded ${filename}.` })
        return
      }

      await postScrapedData(scrapedData, searchQuery)
      setStatus({ kind: 'success', message: 'Scraped data was sent to the API successfully.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.'
      setStatus({ kind: 'error', message })
    } finally {
      setActionState('idle')
    }
  }

  const isLoading = actionState !== 'idle'

  return (
    <main className="popup-shell">
      <section className="popup-card">
        <div className="popup-header">
          <div className="popup-badge">Google Maps</div>
          <h1>Lead Exporter</h1>
          <p>Capture visible business details only when you click a button.</p>
        </div>

        {!scrapedData ? (
          <label className="popup-limit-field">
            <span>How many records do you want to scrape?</span>
            <input
              type="number"
              min="1"
              inputMode="numeric"
              placeholder="Leave blank for all records"
              value={limitInput}
              onChange={event => setLimitInput(event.target.value)}
            />
            <small>Blank = scrape all loaded records.</small>
          </label>
        ) : null}

        <div className="popup-actions">
          {!scrapedData ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => void startScrape()}
              disabled={isLoading}
            >
              {actionState === 'loading-scrape' ? 'Scraping…' : 'Start data scrapping'}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="primary-button"
                onClick={() => void runAction('download')}
                disabled={isLoading}
              >
                {actionState === 'loading-download' ? 'Downloading…' : 'Download JSON'}
              </button>

              <button
                type="button"
                className="secondary-button"
                onClick={() => void runAction('api')}
                disabled={isLoading}
              >
                {actionState === 'loading-api' ? 'Sending…' : 'Send to API'}
              </button>
            </>
          )}
        </div>

        <div className={`status-panel ${status ? status.kind : 'idle'}`} aria-live="polite">
          {isLoading ? (
            <div className="status-loading">
              <span className="spinner" aria-hidden="true" />
              <span>
                {actionState === 'loading-scrape'
                  ? recordLimit
                    ? `Loading all results and scraping first ${recordLimit} records…`
                    : 'Loading all results and scraping every record…'
                  : actionState === 'loading-download'
                    ? 'Preparing JSON download…'
                    : 'Sending scraped data…'}
              </span>
            </div>
          ) : status ? (
            <span>{status.message}</span>
          ) : (
            <span>Ready. Open Google Maps, then choose an action.</span>
          )}
        </div>
      </section>
    </main>
  )
}