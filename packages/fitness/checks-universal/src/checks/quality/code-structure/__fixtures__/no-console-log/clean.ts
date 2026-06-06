import { logger } from './logger.js'

export function greet(name: string): void {
  logger.info({ name })
}
