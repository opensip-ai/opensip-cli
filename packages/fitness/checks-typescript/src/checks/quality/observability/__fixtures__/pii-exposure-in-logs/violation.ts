import { logger } from './logger.js'

export function run(user: { email: string }): void {
  logger.info({ email: user.email })
}
