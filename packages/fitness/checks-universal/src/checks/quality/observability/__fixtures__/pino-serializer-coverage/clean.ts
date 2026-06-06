import { logger } from './logger.js'

export function handle(req: Request): void {
  logger.info({ userId: req.id })
}

interface Request {
  id: string
}
