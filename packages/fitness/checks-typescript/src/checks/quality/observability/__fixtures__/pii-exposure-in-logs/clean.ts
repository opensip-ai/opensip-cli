import { logger } from './logger.js'
import { hashPii } from './pii.js'

export function run(user: { email: string }): void {
  logger.info({ email: hashPii(user.email) })
}
