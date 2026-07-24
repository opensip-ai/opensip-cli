import { config } from './config.js'

export const requestTimeout = config.get('httpTimeout')

export function scheduleRetry(): void {
  setTimeout(() => {
    retry()
  }, config.get('retryDelayMs'))
}

declare function retry(): void
