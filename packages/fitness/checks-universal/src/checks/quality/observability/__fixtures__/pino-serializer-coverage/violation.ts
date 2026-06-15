import { logger } from './logger.js'

export function handle(req: Request): void {
  logger.info({ req })
}

interface Request {
  id: string
}
