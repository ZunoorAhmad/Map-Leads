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
    message: ScrapeCommandMessage,
    callback: (response: ScrapeResponse) => void,
  ): void
}

export type ChromeRuntimeApi = {
  lastError?: { message?: string }
  onMessage: {
    addListener(
      callback: (
        message: ScrapeCommandMessage,
        sender: unknown,
        sendResponse: (response: ScrapeResponse) => void,
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
}

export {}

declare global {
  var chrome: ChromeExtension
}