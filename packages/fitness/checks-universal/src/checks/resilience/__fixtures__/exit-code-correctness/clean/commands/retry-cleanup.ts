import { logger } from './logger.js'

export function runWithCleanup(): void {
  try {
    doWork()
  } catch (error) {
    if (shouldRetry(error)) {
      for (const step of cleanupSteps()) {
        step.run()
      }
    }
    logger.error({ error })
    throw error
  }
}

declare function doWork(): void
declare function shouldRetry(error: unknown): boolean
declare function cleanupSteps(): { run(): void }[]
