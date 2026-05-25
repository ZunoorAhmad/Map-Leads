import { useEffect, useMemo, useState } from 'react'
import type {
  GoogleMapsScrapeJobState,
  RuntimeResponse,
  ScrapedGoogleMapsData,
  StartBatchScrapeMessage,
} from '../types'
import { postScrapedData } from '../utils/api'
import { downloadJson } from '../utils/download'
import './popup.css'

type ActionState = 'idle' | 'loading-start' | 'loading-download' | 'loading-api'

type StatusState =
  | {
      kind: 'success' | 'error'
      message: string
    }
  | null

type ScrapedArray = ScrapedGoogleMapsData[]

const JOB_STORAGE_KEY = 'map-leads-scrape-job'

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

function parseQueriesText(value: string) {
  return value
    .split(/[\n,]/)
    .map(query => query.trim())
    .filter(Boolean)
}

function readSessionJobState() {
  return new Promise<GoogleMapsScrapeJobState | null>(resolve => {
    chrome.storage.local.get(JOB_STORAGE_KEY, items => {
      if (chrome.runtime.lastError) {
        resolve(null)
        return
      }

      const state = items[JOB_STORAGE_KEY] as GoogleMapsScrapeJobState | undefined
      resolve(state ?? null)
    })
  })
}

function requestStartBatch(tabId: number, message: StartBatchScrapeMessage) {
  return new Promise<RuntimeResponse>((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message || ''
        if (errorMsg.includes('back/forward cache') || errorMsg.includes('port')) {
          reject(new Error('The page was moved or refreshed before automation could start. Keep the Maps tab active and visible, then try again.'))
        } else {
          reject(new Error(errorMsg || 'Content script is not available.'))
        }
        return
      }

      if (!response) {
        reject(new Error('The page did not confirm the automation start.'))
        return
      }

      resolve(response as RuntimeResponse)
    })
  })
}

function applyJobState(state: GoogleMapsScrapeJobState | null) {
  return {
    sheetName: state?.sheetName ?? '',
    queriesText: state?.queries.join('\n') ?? '',
    scrapedData: state?.results?.length ? state.results : null,
  }
}

export function Popup() {
  const [actionState, setActionState] = useState<ActionState>('idle')
  const [status, setStatus] = useState<StatusState>(null)
  const [jobState, setJobState] = useState<GoogleMapsScrapeJobState | null>(null)
  const [scrapedData, setScrapedData] = useState<ScrapedArray | null>(null)
  const [sheetName, setSheetName] = useState<string>('')
  const [queriesText, setQueriesText] = useState<string>('')

  const parsedQueries = useMemo(() => parseQueriesText(queriesText), [queriesText])
  const isRunning = jobState?.status === 'running'
  const hasCompletedData = Boolean(scrapedData?.length)
  const activeSheetName = sheetName.trim() || jobState?.sheetName.trim() || ''

  useEffect(() => {
    let isMounted = true

    void readSessionJobState().then(state => {
      if (!isMounted) {
        return
      }

      setJobState(state)

      if (state) {
        const hydrated = applyJobState(state)
        setSheetName(hydrated.sheetName)
        setQueriesText(hydrated.queriesText)
        setScrapedData(hydrated.scrapedData)
      }
    })

    const handleStorageChange = (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: 'session' | 'local',
    ) => {
      if (areaName !== 'local' || !changes[JOB_STORAGE_KEY]) {
        return
      }

      const nextState = (changes[JOB_STORAGE_KEY].newValue as GoogleMapsScrapeJobState | undefined) ?? null
      setJobState(nextState)

      if (nextState) {
        const hydrated = applyJobState(nextState)
        setSheetName(hydrated.sheetName)
        setQueriesText(hydrated.queriesText)
        setScrapedData(hydrated.scrapedData)
      } else {
        setScrapedData(null)
      }
    }

    chrome.storage.onChanged.addListener(handleStorageChange)

    return () => {
      isMounted = false
    }
  }, [])

  async function startScrape() {
    setStatus(null)
    setActionState('loading-start')

    try {
      const activeTab = await queryActiveTab()

      if (!isGoogleMapsUrl(activeTab.url)) {
        throw new Error('Open a Google Maps page before using this extension.')
      }

      const queries = parsedQueries

      if (!sheetName.trim()) {
        throw new Error('Enter a sheet name before starting automation.')
      }

      if (!queries.length) {
        throw new Error('Enter at least one query in the textarea.')
      }

      const startResponse = await requestStartBatch(activeTab.id, {
        type: 'SCRIPT_START_BATCH',
        sheetName: sheetName.trim(),
        queries,
      })

      if (!startResponse.success) {
        throw new Error(startResponse.error)
      }

      setJobState({
        status: 'running',
        sheetName: sheetName.trim(),
        queries,
        totalQueries: queries.length,
        currentQueryIndex: 0,
        currentQuery: queries[0] ?? '',
        completedQueries: 0,
        results: [],
        updatedAt: new Date().toISOString(),
      })
      setScrapedData(null)
      setStatus({ kind: 'success', message: `Automation started for ${queries.length} queries.` })
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
      const rows = scrapedData ?? jobState?.results ?? []

      if (!rows.length) throw new Error('No scraped data available.')

      if (action === 'download') {
        const filename = downloadJson(rows, activeSheetName)
        setStatus({ kind: 'success', message: `Downloaded ${filename}.` })
        return
      }

      await postScrapedData(rows, activeSheetName)
      setStatus({ kind: 'success', message: 'Scraped data was sent to the API successfully.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.'
      setStatus({ kind: 'error', message })
    } finally {
      setActionState('idle')
    }
  }

  const isLoading = actionState !== 'idle'
  const currentQueryNumber = (jobState?.completedQueries ?? 0) + 1
  const totalQueries = jobState?.totalQueries ?? 0
  let statusMessage = 'Ready. Open Google Maps, enter your sheet name and queries, then start automation.'

  if (isRunning) {
    statusMessage = `Running query ${Math.min(currentQueryNumber, totalQueries)} of ${totalQueries}: ${jobState?.currentQuery || 'Preparing…'}`
  } else if (status) {
    statusMessage = status.message
  } else if (jobState?.status === 'completed') {
    statusMessage = `Completed ${jobState.completedQueries} queries and collected ${jobState.results.length} records.`
  } else if (jobState?.status === 'error') {
    statusMessage = jobState.error ?? 'Automation stopped with an error.'
  }

  const primaryActionButton = isRunning ? (
    <button type="button" className="primary-button" disabled>
      Automation running
    </button>
  ) : (
    <button
      type="button"
      className="primary-button"
      onClick={() => void startScrape()}
      disabled={isLoading}
    >
      {actionState === 'loading-start' ? 'Starting…' : 'Start data scrapping'}
    </button>
  )

  const completedActionButtons = hasCompletedData && !isRunning ? (
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
  ) : null

  const statusPanelContent = isLoading && !isRunning ? (
    <div className="status-loading">
      <span className="spinner" aria-hidden="true" />
      <span>
        {actionState === 'loading-start'
          ? 'Starting the Google Maps query queue…'
          : actionState === 'loading-download'
            ? 'Preparing JSON download…'
            : 'Sending scraped data…'}
      </span>
    </div>
  ) : (
    <span>{statusMessage}</span>
  )

  return (
    <main className="popup-shell">
      <section className="popup-card">
        <div className="popup-header">
          <div className="popup-badge">Google Maps</div>
          <h1>Lead Exporter</h1>
          <p>Queue multiple Maps searches, keep the tab open, and continue even if the popup closes.</p>
        </div>

        <label className="popup-field">
          <span>Sheet name</span>
          <input
            type="text"
            placeholder="Enter the sheet name for API search key"
            value={sheetName}
            onChange={event => setSheetName(event.target.value)}
            disabled={isRunning}
          />
          <small>This value is used for every API call in the session.</small>
        </label>

        <label className="popup-field popup-queries-field">
          <span>Queries</span>
          <textarea
            rows={7}
            placeholder={'One query per line or separated by commas\narenas in lahore\narenas in raiwind, arenas in dha'}
            value={queriesText}
            onChange={event => setQueriesText(event.target.value)}
            disabled={isRunning}
          />
          <small>Separate queries with line breaks or commas. Each entry runs as a separate Google Maps search.</small>
        </label>

        <div className="popup-actions">
          {primaryActionButton}
          {completedActionButtons}
        </div>

        <div className={`status-panel ${status ? status.kind : 'idle'}`} aria-live="polite">
          {statusPanelContent}
        </div>
      </section>
    </main>
  )
}