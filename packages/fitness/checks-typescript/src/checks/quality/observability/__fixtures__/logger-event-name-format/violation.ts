import { logger } from './logger.js'

export function run(): void {
  logger.info({
    evt: 'cli.sync',
  })
}
