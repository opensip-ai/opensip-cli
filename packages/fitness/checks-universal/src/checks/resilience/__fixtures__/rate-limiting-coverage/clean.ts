import { rateLimit } from './middleware.js'

export function register(app: App): void {
  app.use(rateLimit())
  app.post('/login', handleLogin)
}

interface App {
  use(mw: unknown): void
  post(path: string, handler: unknown): void
}
declare const handleLogin: unknown
