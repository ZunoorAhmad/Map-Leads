export type ScrapedGoogleMapsData = {
  name: string
  rating: string
  // `reviews` removed: rating is sufficient
  category?: string
  address: string
  phone: string
  website: string
  hours?: string
  services?: string
  latitude?: string
  longitude?: string
  scrapedAt: string
}

export type ScrapeSuccessResponse = {
  success: true
  data: ScrapedGoogleMapsData
}

export type ScrapeAllSuccessResponse = {
  success: true
  data: ScrapedGoogleMapsData[]
}

export type ScrapeErrorResponse = {
  success: false
  error: string
}

export type ScrapeResponse = ScrapeSuccessResponse | ScrapeAllSuccessResponse | ScrapeErrorResponse

export type StartBatchScrapeMessage = {
  type: 'SCRIPT_START_BATCH'
  sheetName: string
  queries: string[]
}

export type PostResultsMessage = {
  type: 'SCRIPT_POST_RESULTS'
  sheetName: string
  query: string
  data: ScrapedGoogleMapsData[]
}

export type StartBatchAckResponse = {
  success: true
  started: true
}

export type ApiPostSuccessResponse = {
  success: true
}

export type ApiPostErrorResponse = {
  success: false
  error: string
}

export type ApiPostResponse = ApiPostSuccessResponse | ApiPostErrorResponse

export type RuntimeMessage = ScrapeCommandMessage | StartBatchScrapeMessage | PostResultsMessage

export type RuntimeResponse = ScrapeResponse | StartBatchAckResponse | ApiPostResponse

export type GoogleMapsScrapeJobState = {
  status: 'idle' | 'running' | 'completed' | 'error'
  sheetName: string
  queries: string[]
  totalQueries: number
  currentQueryIndex: number
  currentQuery: string
  completedQueries: number
  results: ScrapedGoogleMapsData[]
  error?: string
  updatedAt: string
}

export type ScrapeCommandMessage = {
  type: 'SCRIPT_SCRAPE' | 'SCRIPT_START_SCRAPE'
  limit?: number | null
}

export type GoogleMapsTab = {
  id?: number
  url?: string
}

export type ChromeTabsApi = {
  query(
    queryInfo: { active: true; currentWindow: true },
    callback: (tabs: GoogleMapsTab[]) => void,
  ): void
  sendMessage(
    tabId: number,
    message: RuntimeMessage,
    callback: (response: RuntimeResponse) => void,
  ): void
}

export type ChromeStorageArea = {
  get(keys: string | string[] | null, callback: (items: Record<string, unknown>) => void): void
  set(items: Record<string, unknown>, callback?: () => void): void
  remove(keys: string | string[], callback?: () => void): void
  clear(callback?: () => void): void
}

export type ChromeStorageApi = {
  session: ChromeStorageArea
  local: ChromeStorageArea
  onChanged: {
    addListener(
      callback: (
        changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
        areaName: 'session' | 'local',
      ) => void,
    ): void
  }
}

export type ChromeRuntimeApi = {
  sendMessage(message: RuntimeMessage, callback: (response: RuntimeResponse) => void): void
  lastError?: { message?: string }
  onMessage: {
    addListener(
      callback: (
        message: RuntimeMessage,
        sender: unknown,
        sendResponse: (response: RuntimeResponse) => void,
      ) => boolean | void,
    ): void
  }
  onInstalled: {
    addListener(callback: () => void): void
  }
}

export type ChromeDownloadsApi = {
  download(options: {
    url: string
    filename: string
    saveAs?: boolean
  }): void | Promise<number>
}

export type ChromeActionApi = {
  onClicked: {
    addListener(callback: (tab: GoogleMapsTab) => void): void
  }
}

export type ChromeExtension = {
  tabs: ChromeTabsApi
  runtime: ChromeRuntimeApi
  downloads: ChromeDownloadsApi
  action: ChromeActionApi
  storage: ChromeStorageApi
}

export {}

declare global {
  var chrome: ChromeExtension
}