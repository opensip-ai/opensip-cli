import { logger } from './logger.js'
import { generateCorrelationId } from './ids.js'

export function run(): void {
  logger.info({ correlationId: generateCorrelationId() })
}
