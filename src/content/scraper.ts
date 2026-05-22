import type {
  ScrapeCommandMessage,
  ScrapeResponse,
  ScrapedGoogleMapsData,
} from '../types'

const RESULT_CARD_SELECTOR = 'div[role="article"], [role="listitem"], .Nv2PK, .section-result, [data-result-id]'
const DETAILS_WAIT_TIMEOUT_MS = 2200
const SCROLL_SETTLE_MS = 180
const DETAIL_POLL_INTERVAL_MS = 80

function logScrape(...args: unknown[]) {
  console.log('[map-leads]', ...args)
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
  return text.replace(/\s+/g, ' ').trim()
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

async function waitForFeedStability(timeout = 1200) {
  const start = Date.now()
  let lastCount = collectVisibleCardDescriptors().length
  let stableChecks = 0
  let loaderLogged = false

  while (Date.now() - start < timeout) {
    // detect loader-like elements
    const loader = document.querySelector('[role="progressbar"], .section-loading, [aria-busy="true"], .m6QErb .section-loading')
    if (loader && !loaderLogged) {
      loaderLogged = true
      logScrape('loader detected — awaiting feed to settle')
      const snapshot = collectVisibleCardDescriptors().slice(0, 30).map(d => ({ identity: d.identity, title: d.title }))
      logScrape('cards at loader time (sample)', snapshot)
    }

    await sleep(150)
    const nowCount = collectVisibleCardDescriptors().length
    if (nowCount === lastCount) {
      stableChecks += 1
    } else {
      stableChecks = 0
      lastCount = nowCount
    }

    // consider stable after two consecutive equal counts
    if (stableChecks >= 2) {
      const finalSnapshot = collectVisibleCardDescriptors().slice(0, 40).map(d => ({ identity: d.identity, title: d.title }))
      logScrape('feed settled', { visibleCount: finalSnapshot.length, sample: finalSnapshot })
      return
    }
  }

  logScrape('feed stability wait timed out', { elapsedMs: Date.now() - start, lastVisibleCount: lastCount })
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

async function waitForDetailReady(previousSignature: string, expectedTitle: string) {
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
      logScrape('detail ready', {
        expectedTitle,
        nextName,
        elapsedMs: Date.now() - start,
        nextSignature,
      })
      return true
    }

    if (isRealPlaceName(nextName) && nextAddress && hasImportantSelector && nextSignature !== previousSignature) {
      logScrape('detail ready via address', {
        expectedTitle,
        nextName,
        elapsedMs: Date.now() - start,
        nextSignature,
      })
      return true
    }

    await sleep(DETAIL_POLL_INTERVAL_MS)
  }

  logScrape('detail wait timed out', {
    expectedTitle,
    previousSignature,
    elapsedMs: Date.now() - start,
  })
  return false
}

async function clickCardAndScrape(card: HTMLElement, expectedTitle: string) {
  const clickTarget = card.querySelector<HTMLElement>('a[href], button, div[role="button"]') ?? card
  const maxAttempts = 1

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const beforeSignature = getPlaceSignature(getDetailPaneRoot())
    const start = Date.now()
    logScrape('click attempt start', { attempt: attempt + 1, expectedTitle, beforeSignature })
    card.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
    await sleep(50)

    try {
      clickTarget.click()
    } catch {
      const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
      clickTarget.dispatchEvent(evt)
    }

    logScrape('click dispatched', { attempt: attempt + 1, expectedTitle })

    const opened = await waitForDetailReady(beforeSignature, expectedTitle)
    if (!opened) {
      logScrape('retrying click', { attempt: attempt + 1, expectedTitle, elapsedMs: Date.now() - start })
      continue
    }

    await sleep(40)

    const details = extractPlaceDetailsFromPane()
    const currentSignature = getPlaceSignature(getDetailPaneRoot())

    logScrape('scraped row', {
      attempt: attempt + 1,
      expectedTitle,
      currentName: details.name,
      currentSignature,
      elapsedMs: Date.now() - start,
    })

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

  if (!container) {
    return results
  }

  let noProgressRounds = 0
  let lastScrollHeight = container.scrollHeight
  logScrape('scrape start', { limit: typeof limit === 'number' ? limit : null })

  for (let i = 0; i < 200; i += 1) {
    const visibleCards = collectVisibleCardDescriptors()
    logScrape('visible cards batch', { batch: i + 1, visibleCount: visibleCards.length, seenCardCount: seen.size, uniquePlacesCount: scrapedSignatures.size, resultsCount: results.length })

    for (const { identity, title, card } of visibleCards) {
      if (seen.has(identity)) {
        continue
      }

      seen.add(identity)

      if (typeof limit === 'number' && limit > 0 && results.length >= limit) {
        return results
      }

      try {
        const row = await clickCardAndScrape(card, title)
        if (row.name && isRealPlaceName(row.name)) {
          const actualSignature = `${row.name}||${row.address}||${row.phone}`
          
          if (scrapedSignatures.has(actualSignature)) {
            logScrape('row skipped - duplicate signature', { title, rowName: row.name, existingCount: results.length })
            continue
          }
          
          scrapedSignatures.add(actualSignature)
          results.push(row)
          logScrape('row accepted', { title, rowName: row.name, resultsCount: results.length })
        }
      } catch {
        logScrape('row skipped after failed open', { title })
        continue
      }
    }

    const previousTotal = scrapedSignatures.size
    container.scrollTop = container.scrollTop + Math.max(520, Math.floor(container.clientHeight * 0.8))
    await sleep(SCROLL_SETTLE_MS)
    // Wait for feed to stabilize after loader/virtual scroll re-render
    try {
      await waitForFeedStability()
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

  logScrape('scrape finished', { resultsCount: results.length, uniquePlacesCount: scrapedSignatures.size, seenCardIdentities: seen.size })
  return results
}

async function handleScrapeRequest(message: ScrapeCommandMessage, sendResponse: (response: ScrapeResponse) => void) {
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
  void handleScrapeRequest(message as ScrapeCommandMessage, sendResponse)
  return true
})