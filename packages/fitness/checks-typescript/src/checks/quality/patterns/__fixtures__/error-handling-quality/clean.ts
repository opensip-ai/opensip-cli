import { logger } from './logger.js'

export function loadConfigJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    logger.warn({ evt: 'parse.failed', err })
    return null
  }
}