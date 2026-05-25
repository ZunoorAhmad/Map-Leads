import { postScrapedData } from '../utils/api'
import type { ApiPostResponse, PostResultsMessage, RuntimeMessage } from '../types'

function isPostResultsMessage(message: RuntimeMessage): message is PostResultsMessage {
  return message.type === 'SCRIPT_POST_RESULTS'
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Google Maps Exporter installed.')
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isPostResultsMessage(message)) {
    return false
  }

  void (async () => {
    try {
      await postScrapedData(message.data, message.sheetName)
      const response: ApiPostResponse = { success: true }
      sendResponse(response)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Failed to post scraped data to the API.'
      const response: ApiPostResponse = { success: false, error: messageText }
      sendResponse(response)
    }
  })()

  return true
})