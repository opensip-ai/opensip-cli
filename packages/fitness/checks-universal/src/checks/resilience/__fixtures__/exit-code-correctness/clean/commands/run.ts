import { logger } from './logger.js'

export function run(): void {
  try {
    doWork()
  } catch (error) {
    logger.error({ error })
    throw error
  }
}

declare function doWork(): void
