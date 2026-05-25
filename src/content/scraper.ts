import type {
  ApiPostResponse,
  ScrapeResponse,
  GoogleMapsScrapeJobState,
  RuntimeMessage,
  StartBatchScrapeMessage,
  ScrapedGoogleMapsData,
} from '../types'

const RESULT_CARD_SELECTOR = 'div[role="article"], [role="listitem"], .Nv2PK, .section-result, [data-result-id]'
const JOB_STORAGE_KEY = 'map-leads-scrape-job'
const SEARCH_INPUT_SELECTORS = [
  'div[role="search"] form.NhWQq input[name="q"]',
  'div[role="search"] input.UGojuc[name="q"]',
  'div[role="search"] input[name="q"]',
  'input#searchboxinput',
  'input[aria-label*="Search Google Maps"]',
  'input[placeholder*="Search Google Maps"]',
  'form.NhWQq input[name="q"]',
  'input.UGojuc[name="q"]',
]
const DETAILS_WAIT_TIMEOUT_MS = 2200
const SCROLL_SETTLE_MS = 180
const CLICK_SETTLE_MS = 500
const CLICK_RETRY_DELAYS_MS = [500, 1000]
const DETAIL_POLL_INTERVAL_MS = 80

type DelayLogEntry = {
  batch: number
  durationMs: number
  loaderDetected: boolean
  visibleBefore: number
  visibleAfter: number
}

type ScrapeRunStats = {
  startTimeMs: number
  acceptedCount: number
  duplicateCount: number
  failedOpenCount: number
  delayEntries: DelayLogEntry[]
  lastAcceptedName: string
  lastAcceptedIndex: number
}

let batchInProgress = false

function logScrape(event: string, details?: unknown) {
  if (typeof details === 'undefined') {
    console.log('[map-leads]', event)
    return
  }

  console.log('[map-leads]', event, details)
}

function setSessionValue(key: string, value: unknown) {
  return new Promise<void>((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Failed to persist job state.'))
        return
      }

      resolve()
    })
  })
}

function updateSessionJobState(nextState: GoogleMapsScrapeJobState) {
  return setSessionValue(JOB_STORAGE_KEY, nextState)
}

function findSearchInput() {
  for (const selector of SEARCH_INPUT_SELECTORS) {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(selector))
    const input = inputs.find(candidate => {
      if (!(candidate instanceof HTMLInputElement)) {
        return false
      }

      if (candidate.closest('#directions-searchbox-0, #directions-searchbox-1, .JuLCid, .jcoKVe')) {
        return false
      }

      const style = window.getComputedStyle(candidate)
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false
      }

      return true
    })

    if (input) {
      return input
    }
  }

  return null
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  descriptor?.set?.call(input, value)
}

async function waitForSearchResultsToLoad(timeoutMs = 15000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const cards = collectVisibleCardDescriptors()
    const container = getResultsContainer()

    if (cards.length > 0 && container) {
      return
    }

    await sleep(250)
  }

  throw new Error('Google Maps search results did not load in time.')
}

async function submitMapsQuery(query: string) {
  let input = findSearchInput()

  if (!input) {
    const closeDirectionsButton = document.querySelector<HTMLElement>(
      'button[aria-label="Close directions"], button[jsaction*="directions.close"]',
    )

    if (closeDirectionsButton) {
      closeDirectionsButton.click()
      await sleep(350)
      input = findSearchInput()
    }
  }

  if (!input) {
    throw new Error('Google Maps search input was not found. Make sure the Maps page is open and visible.')
  }

  input.focus()
  input.select()
  setNativeInputValue(input, query)
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }))
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  )
  input.dispatchEvent(
    new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  )

  const searchButton =
    document.querySelector<HTMLElement>('div[role="search"] button[aria-label="Search"]') ??
    document.querySelector<HTMLElement>('button#searchbox-searchbutton') ??
    input.closest('form')?.parentElement?.querySelector<HTMLElement>('button[aria-label="Search"]') ??
    null
  searchButton?.click()

  await sleep(800)
  await waitForSearchResultsToLoad()
  await sleep(400)
}

function requestApiPost(data: ScrapedGoogleMapsData[], sheetName: string, query: string) {
  return new Promise<ApiPostResponse>((resolve, reject) => {
    const message: RuntimeMessage = {
      type: 'SCRIPT_POST_RESULTS',
      sheetName,
      query,
      data,
    }

    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'API relay is unavailable.'))
        return
      }

      resolve(response as ApiPostResponse)
    })
  })
}

function buildRunningState(
  sheetName: string,
  queries: string[],
  currentQueryIndex: number,
  currentQuery: string,
  completedQueries: number,
  results: ScrapedGoogleMapsData[],
  error?: string,
): GoogleMapsScrapeJobState {
  return {
    status: error ? 'error' : completedQueries >= queries.length && queries.length > 0 ? 'completed' : 'running',
    sheetName,
    queries,
    totalQueries: queries.length,
    currentQueryIndex,
    currentQuery,
    completedQueries,
    results,
    error,
    updatedAt: new Date().toISOString(),
  }
}

async function runQueuedMapsScrape(message: StartBatchScrapeMessage) {
  if (batchInProgress) {
    throw new Error('A scraping session is already running in this tab.')
  }

  const sheetName = message.sheetName.trim()
  const queries = message.queries.map(query => query.trim()).filter(Boolean)

  if (!sheetName) {
    throw new Error('Enter a sheet name before starting the automation.')
  }

  if (!queries.length) {
    throw new Error('Enter at least one Google Maps query.')
  }

  batchInProgress = true

  const collectedRows: ScrapedGoogleMapsData[] = []
  const seenRows = new Set<string>()
  let completedQueries = 0
  let currentQueryIndex = 0
  let currentQuery = queries[0] ?? ''

  try {
    await updateSessionJobState(buildRunningState(sheetName, queries, 0, queries[0], 0, []))

    for (let index = 0; index < queries.length; index += 1) {
      currentQueryIndex = index
      currentQuery = queries[index]
      await updateSessionJobState(buildRunningState(sheetName, queries, index, currentQuery, completedQueries, collectedRows))

      await submitMapsQuery(currentQuery)

      const rows = (await scrapeAllLoadedRecords()).filter(row => isRealPlaceName(row.name))

      for (const row of rows) {
        const rowSignature = `${row.name}||${row.address}||${row.phone}`
        if (seenRows.has(rowSignature)) {
          continue
        }

        seenRows.add(rowSignature)
        collectedRows.push(row)
      }

      const apiResponse = await requestApiPost(rows, sheetName, currentQuery)
      if (!apiResponse.success) {
        throw new Error(apiResponse.error)
      }

      completedQueries = index + 1
      await updateSessionJobState(buildRunningState(sheetName, queries, index + 1, currentQuery, completedQueries, collectedRows))
    }

    await updateSessionJobState({
      status: 'completed',
      sheetName,
      queries,
      totalQueries: queries.length,
      currentQueryIndex: Math.max(queries.length - 1, 0),
      currentQuery: queries[queries.length - 1] ?? '',
      completedQueries: queries.length,
      results: collectedRows,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Failed to complete the query queue.'

    await updateSessionJobState(buildRunningState(sheetName, queries, currentQueryIndex, currentQuery, completedQueries, collectedRows, messageText))
    throw error
  } finally {
    batchInProgress = false
  }
}

function summarizeRunStats(stats: ScrapeRunStats, totalResults: number) {
  const elapsedMs = Date.now() - stats.startTimeMs
  const totalDelayMs = stats.delayEntries.reduce((sum, entry) => sum + entry.durationMs, 0)

  console.log('[map-leads] scrape summary', {
    totalElapsedMs: elapsedMs,
    totalElapsedSeconds: Number((elapsedMs / 1000).toFixed(2)),
    totalRecords: totalResults,
    acceptedRecords: stats.acceptedCount,
    duplicatesRemoved: stats.duplicateCount,
    failedOpens: stats.failedOpenCount,
    delayCount: stats.delayEntries.length,
    totalDelayMs,
    delayEvents: stats.delayEntries,
    lastScrapedRecord: stats.lastAcceptedName,
    lastScrapedIndex: stats.lastAcceptedIndex,
  })
}

function sleep(ms: number) {
  return new Promise<void>(resolve => {
    window.setTimeout(resolve, ms)
  })
}

function qText(el: ParentNode | null, selectors: string[]) {
  if (!el) return ''

  for (const selector of selectors) {
    const node = el.querySelector<HTMLElement>(selector)
    const text = node?.textContent?.trim() ?? node?.getAttribute('aria-label')?.trim()

    if (text) {
      return text
    }
  }

  return ''
}

function qHref(el: ParentNode | null, selectors: string[]) {
  if (!el) return ''

  for (const selector of selectors) {
    const node = el.querySelector<HTMLAnchorElement>(selector)
    const href = node?.href?.trim()

    if (href) {
      return href
    }
  }

  return ''
}

function normalize(text: string) {
  return text
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractSearchPageCards() {
  const selectors = [
    RESULT_CARD_SELECTOR,
    'div[role="feed"] [role="listitem"]',
    'div[role="feed"] div[role="article"]',
    'div[role="feed"] .Nv2PK',
    'div[role="feed"] .section-result',
    'div[role="feed"] [data-result-id]',
    'div[role="feed"] a[href*="/maps/place/"]',
    '.m6QErb div[role="article"]',
    '.m6QErb [role="listitem"]',
    '.m6QErb .Nv2PK',
  ]

  const cards = selectors.flatMap(selector => Array.from(document.querySelectorAll<HTMLElement>(selector)))

  // Only keep cards that look like real result items: have a title, data-result-id, or an anchor href
  const filtered = Array.from(new Set(cards)).filter(card => {
    const hasTitle = Boolean(qText(card, ['.qBF1Pd', 'h3', '[role="heading"]']))
    const hasResultId = Boolean(card.getAttribute('data-result-id'))
    const hasHref = Boolean(card.querySelector<HTMLAnchorElement>('a[href]'))
    return hasTitle || hasResultId || hasHref
  })

  return filtered
}

function getCardIdentity(card: HTMLElement, index: number) {
  const resultId = card.getAttribute('data-result-id')?.trim()

  if (resultId) {
    return `id:${resultId}`
  }

  const href = card.querySelector<HTMLAnchorElement>('a[href]')?.href?.trim()

  if (href) {
    return `href:${href}`
  }

  const title = qText(card, ['.qBF1Pd', 'h3', '[role="heading"]'])

  if (title) {
    return `title:${title}`
  }

  const text = normalize(card.textContent ?? '')

  if (text) {
    return `text:${text.slice(0, 180)}`
  }

  return `index:${index}`
}

function getResultsContainer() {
  const feedCandidates = [
    document.querySelector<HTMLElement>('div[role="feed"]'),
    document.querySelector<HTMLElement>('div[aria-label*="Results"]'),
    document.querySelector<HTMLElement>('div[aria-label*="Search results"]'),
    document.querySelector<HTMLElement>('.m6QErb'),
    document.querySelector<HTMLElement>('.t39EBf'),
    document.querySelector<HTMLElement>('.m6QErb[aria-label]'),
    document.querySelector<HTMLElement>('.m6QErb[tabindex]'),
  ].filter(Boolean) as HTMLElement[]

  const feed = feedCandidates.find(candidate => {
    const cards = candidate.querySelectorAll(RESULT_CARD_SELECTOR)
    return cards.length > 0 && candidate.scrollHeight > candidate.clientHeight + 60
  })

  if (feed) {
    return feed
  }

  const firstVisibleCard = extractSearchPageCards()[0]

  if (firstVisibleCard) {
    let ancestor = firstVisibleCard.parentElement

    while (ancestor && ancestor !== document.body) {
      const style = window.getComputedStyle(ancestor)
      const canScrollY = /(auto|scroll)/i.test(style.overflowY)
      const hasRoomToScroll = ancestor.scrollHeight > ancestor.clientHeight + 20

      if (canScrollY && hasRoomToScroll) {
        return ancestor
      }

      ancestor = ancestor.parentElement
    }
  }

  const candidates = Array.from(document.querySelectorAll<HTMLElement>('div'))
  return (
    candidates.find(el => {
      const hasCards = el.querySelector(RESULT_CARD_SELECTOR)
      return Boolean(hasCards) && el.scrollHeight > el.clientHeight + 120
    }) ?? null
  )
}

function collectVisibleCardDescriptors() {
  const cards = extractSearchPageCards()
  const descriptors = cards.map((card, index) => ({
    identity: getCardIdentity(card, index),
    title: normalize(qText(card, ['.qBF1Pd', 'h3', '[role="heading"]'])),
    card,
  }))

  // Filter out phantom descriptors that have no title and no stable id/href
  return descriptors.filter(d => {
    if (d.title) return true
    if (d.identity.startsWith('id:') || d.identity.startsWith('href:') || d.identity.startsWith('text:')) return true
    return false
  })
}

async function waitForFeedStability(batch: number, timeout = 7000): Promise<DelayLogEntry> {
  const start = Date.now()
  let lastCount = collectVisibleCardDescriptors().length
  let stableChecks = 0
  let loaderLogged = false
  const visibleBefore = lastCount

  while (Date.now() - start < timeout) {
    // detect loader-like elements
    const loader = document.querySelector('[role="progressbar"], .section-loading, [aria-busy="true"], .m6QErb .section-loading')
    if (loader && !loaderLogged) {
      loaderLogged = true
      const snapshot = collectVisibleCardDescriptors().slice(0, 15).map(d => ({ identity: d.identity, title: d.title }))
      logScrape('loader detected', { batch, visibleBefore, sample: snapshot })
    }

    await sleep(150)
    const nowCount = collectVisibleCardDescriptors().length
    if (nowCount === lastCount) {
      stableChecks += 1
    } else {
      stableChecks = 0
      lastCount = nowCount
    }

    // consider stable after three consecutive equal counts
    if (stableChecks >= 3) {
      const visibleAfter = collectVisibleCardDescriptors().length
      return {
        batch,
        durationMs: Date.now() - start,
        loaderDetected: loaderLogged,
        visibleBefore,
        visibleAfter,
      }
    }
  }

  const visibleAfter = collectVisibleCardDescriptors().length
  return {
    batch,
    durationMs: Date.now() - start,
    loaderDetected: loaderLogged,
    visibleBefore,
    visibleAfter: Math.max(visibleAfter, lastCount),
  }
}

function getDetailPaneRoot() {
  const detailTrigger = document.querySelector<HTMLElement>(
    'button[data-item-id="address"], [data-item-id="address"], a[data-item-id="authority"], [data-item-id^="phone"], h1.DUwDvf'
  )

  const candidate =
    detailTrigger?.closest<HTMLElement>('[role="main"], [role="dialog"], div[data-section-id], .m6QErb, .t39EBf') ??
    document.querySelector<HTMLElement>('[role="main"]') ??
    document.querySelector<HTMLElement>('div[data-section-id]')

  return candidate ?? document.body
}

function isRealPlaceName(name: string) {
  const normalized = name.toLowerCase()
  return Boolean(name) && normalized !== 'results' && normalized !== 'google maps'
}

function getPlaceSignature(root: ParentNode) {
  const name = normalize(qText(root, ['h1.DUwDvf', 'h1', '[role="heading"]']))
  const address = normalize(qText(root, ['button[data-item-id="address"] .Io6YTe', 'button[data-item-id="address"]', '[data-item-id="address"] .Io6YTe', '[data-item-id="address"]']))
  const phone = normalize(qText(root, ['button[data-item-id^="phone"] .Io6YTe', 'button[data-item-id^="phone"]', '[data-item-id^="phone"] .Io6YTe', '[data-item-id^="phone"]']))

  return `${name}||${address}||${phone}`
}

function isValidHoursText(text: string) {
  if (!text) {
    return false
  }

  if (/^Rs\s*\d/i.test(text)) {
    return false
  }

  return /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Open 24 hours|Closed)/i.test(text)
}

function normalizeWebsite(href: string) {
  if (!href) {
    return ''
  }

  try {
    const url = new URL(href)
    const host = url.hostname.toLowerCase()
    const path = url.pathname.toLowerCase()

    if (host === 'support.google.com' || host.endsWith('.google.com') || host === 'google.com') {
      return ''
    }

    if (path.includes('contributionpolicy') || path.includes('local-listings')) {
      return ''
    }

    return url.href
  } catch {
    return ''
  }
}

function extractPlaceDetailsFromPane(): ScrapedGoogleMapsData {
  const root = getDetailPaneRoot()

  const name = normalize(qText(root, ['h1.DUwDvf', 'h1', '[role="heading"]']))

  const rating = normalize(qText(root, ['.F7nice span', '.F7nice', '[aria-label*="stars"]']))

  const category = normalize(qText(root, ['button[jsaction*="pane.category"]', '.DkEaL', '.fontBodyMedium']))

  let address = ''
  const addressBtn = root.querySelector<HTMLElement>('button[data-item-id="address"], [data-item-id="address"]')
  if (addressBtn) {
    address = normalize(qText(addressBtn, ['.Io6YTe', '.rogA2c', '.Io6YTe.fontBodyMedium', 'div']))
  } else {
    address = normalize(qText(root, ['[data-item-id="address"] .Io6YTe', '[data-item-id="address"]']))
  }

  let phone = ''
  const phoneBtn = root.querySelector<HTMLElement>('button[data-item-id^="phone"], [data-item-id^="phone"]')
  if (phoneBtn) {
    phone = normalize(qText(phoneBtn, ['.Io6YTe', 'div', '.rogA2c']))
  } else {
    phone = normalize(qText(root, ['[data-item-id^="phone"] .Io6YTe', '[data-item-id^="phone"]']))
  }

  const website = normalizeWebsite(qHref(root, ['a[data-item-id="authority"]', 'a[aria-label*="Website"]', 'a[href*="http"]']))

  let hours = ''
  const hoursTable = root.querySelector<HTMLTableElement>('table.eK4R0e, table')
  if (hoursTable) {
    const rows = Array.from(hoursTable.querySelectorAll('tr'))
    hours = rows.map(r => r.textContent?.trim()).filter(Boolean).join(' | ')
  } else {
    hours = normalize(qText(root, ['[aria-label*="Hours"]', '[data-item-id*="hours"]']))
  }

  if (!isValidHoursText(hours)) {
    hours = ''
  }

  const services = normalize(qText(root, ['.LTs0Rc div[aria-hidden="true"]', '.E0DTEd', '.RcCsl']))

  const currentUrl = new URL(window.location.href)
  const lat = currentUrl.searchParams.get('lat') ?? ''
  const lng = currentUrl.searchParams.get('lng') ?? ''

  return {
    name,
    rating,
    category,
    address,
    phone,
    website,
    hours,
    services,
    latitude: lat,
    longitude: lng,
    scrapedAt: new Date().toISOString(),
  }
}

async function waitForDetailReady(previousSignature: string) {
  const start = Date.now()
  const importantSelectors = [
    'button[data-item-id="address"]',
    '[data-item-id^="phone"]',
    'a[data-item-id="authority"]',
    'h1.DUwDvf',
  ]

  while (Date.now() - start < DETAILS_WAIT_TIMEOUT_MS) {
    const root = getDetailPaneRoot()
    const nextName = normalize(qText(root, ['h1.DUwDvf', 'h1', '[role="heading"]']))
    const nextAddress = normalize(qText(root, ['button[data-item-id="address"] .Io6YTe', 'button[data-item-id="address"]', '[data-item-id="address"] .Io6YTe', '[data-item-id="address"]']))
    const nextSignature = getPlaceSignature(root)
    const hasImportantSelector = importantSelectors.some(sel => Boolean(root.querySelector(sel)))
    if (isRealPlaceName(nextName) && nextSignature !== previousSignature && hasImportantSelector) {
      return true
    }

    if (isRealPlaceName(nextName) && nextAddress && hasImportantSelector && nextSignature !== previousSignature) {
      return true
    }

    await sleep(DETAIL_POLL_INTERVAL_MS)
  }

  return false
}

async function clickCardAndScrape(card: HTMLElement) {
  const clickTarget = card.querySelector<HTMLElement>('a[href], button, div[role="button"]') ?? card
  const maxAttempts = 3

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      const retryDelayMs = CLICK_RETRY_DELAYS_MS[attempt - 1] ?? CLICK_RETRY_DELAYS_MS[CLICK_RETRY_DELAYS_MS.length - 1]
      logScrape('retrying same card', { attempt: attempt + 1, retryDelayMs })
      await sleep(retryDelayMs)
    }

    const beforeSignature = getPlaceSignature(getDetailPaneRoot())
    card.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
    await sleep(50)

    try {
      clickTarget.click()
    } catch {
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
      clickTarget.dispatchEvent(evt)
    }

    await sleep(CLICK_SETTLE_MS)

    const opened = await waitForDetailReady(beforeSignature)
    if (!opened) {
      continue
    }

    await sleep(40)

    const details = extractPlaceDetailsFromPane()
    const currentSignature = getPlaceSignature(getDetailPaneRoot())

    if (isRealPlaceName(details.name) && currentSignature !== beforeSignature) {
      if (!details.website) {
        details.website = normalizeWebsite(qHref(card, ['a[href*="/maps/place/"]', 'a[href*="/place/"]', 'a']))
      }

      return details
    }
  }

  throw new Error('Failed to open a place details pane.')
}

async function scrapeAllLoadedRecords(limit?: number | null) {
  const results: ScrapedGoogleMapsData[] = []
  const seen = new Set<string>()
  const scrapedSignatures = new Set<string>()
  const container = getResultsContainer()
  const stats: ScrapeRunStats = {
    startTimeMs: Date.now(),
    acceptedCount: 0,
    duplicateCount: 0,
    failedOpenCount: 0,
    delayEntries: [],
    lastAcceptedName: '',
    lastAcceptedIndex: 0,
  }

  if (!container) {
    return results
  }

  let noProgressRounds = 0
  let lastScrollHeight = container.scrollHeight
  logScrape('scrape start', { limit: typeof limit === 'number' ? limit : null })

  for (let i = 0; i < 200; i += 1) {
    const visibleCards = collectVisibleCardDescriptors()

    for (const { identity, title, card } of visibleCards) {
      if (seen.has(identity)) {
        continue
      }

      if (typeof limit === 'number' && limit > 0 && results.length >= limit) {
        return results
      }

      try {
        const row = await clickCardAndScrape(card)
        if (row.name && isRealPlaceName(row.name)) {
          const actualSignature = `${row.name}||${row.address}||${row.phone}`
          seen.add(identity)
          
          if (scrapedSignatures.has(actualSignature)) {
            stats.duplicateCount += 1
            logScrape('duplicate removed', { title, rowName: row.name, duplicateCount: stats.duplicateCount, resultsCount: results.length })
            continue
          }
          
          scrapedSignatures.add(actualSignature)
          results.push(row)
          stats.acceptedCount += 1
          stats.lastAcceptedName = row.name
          stats.lastAcceptedIndex = results.length
          logScrape('row accepted', { index: results.length, title, rowName: row.name })
        }
      } catch {
        stats.failedOpenCount += 1
        logScrape('row skipped after failed open', { title, failedOpenCount: stats.failedOpenCount })
        continue
      }
    }

    const previousTotal = scrapedSignatures.size
    container.scrollTop = container.scrollTop + Math.max(520, Math.floor(container.clientHeight * 0.8))
    await sleep(SCROLL_SETTLE_MS)
    // Wait for feed to stabilize after loader/virtual scroll re-render
    try {
      const delayEntry = await waitForFeedStability(i + 1, 7000)
      stats.delayEntries.push(delayEntry)

      const firstVisible = collectVisibleCardDescriptors()[0]?.title ?? ''
      logScrape('loader delay', {
        delayNumber: stats.delayEntries.length,
        batch: delayEntry.batch,
        durationMs: delayEntry.durationMs,
        loaderDetected: delayEntry.loaderDetected,
        visibleBefore: delayEntry.visibleBefore,
        visibleAfter: delayEntry.visibleAfter,
        lastScrapedRecord: stats.lastAcceptedName,
        firstVisibleAfterLoad: firstVisible,
      })
    } catch (e) {
      // swallow - waitForFeedStability logs internally on timeout
    }

    const currentScrollHeight = container.scrollHeight
    const atBottom = container.scrollTop + container.clientHeight >= currentScrollHeight - 8
    const gainedNewRows = scrapedSignatures.size > previousTotal

    if (atBottom && currentScrollHeight === lastScrollHeight && !gainedNewRows) {
      noProgressRounds += 1
    } else {
      noProgressRounds = 0
    }

    lastScrollHeight = currentScrollHeight

    if (noProgressRounds >= 5) {
      logScrape('scrape stopping - feed exhausted', {
        batch: i + 1,
        seenCount: seen.size,
        uniquePlacesCount: scrapedSignatures.size,
        resultsCount: results.length,
        currentScrollHeight,
      })
      break
    }
  }

  summarizeRunStats(stats, results.length)
  return results
}

async function handleScrapeRequest(message: RuntimeMessage, sendResponse: (response: ScrapeResponse | { success: true; started: true } | { success: false; error: string }) => void) {
  if (message.type === 'SCRIPT_START_BATCH') {
    sendResponse({ success: true, started: true })

    void runQueuedMapsScrape(message).catch(error => {
      logScrape('queued scrape failed', error)
    })

    return
  }

  if (message.type !== 'SCRIPT_SCRAPE' && message.type !== 'SCRIPT_START_SCRAPE') {
    sendResponse({ success: false, error: 'Unsupported message type.' })
    return
  }

  try {
    const rows = (await scrapeAllLoadedRecords(message.limit)).filter(row => isRealPlaceName(row.name))

    if (!rows.length) {
      sendResponse({ success: false, error: 'No visible Google Maps search results found on this page.' })
      return
    }

    sendResponse({ success: true, data: rows })
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Failed to scrape Google Maps data.'
    sendResponse({ success: false, error: messageText })
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleScrapeRequest(message as RuntimeMessage, sendResponse)
  return true
})