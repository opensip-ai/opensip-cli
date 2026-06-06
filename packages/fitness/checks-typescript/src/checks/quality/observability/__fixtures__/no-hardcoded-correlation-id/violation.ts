import { logger } from './logger.js'

export function run(): void {
  logger.info({ correlationId: 'static-request-1' })
}
