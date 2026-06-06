export function register(app: App): void {
  app.post('/login', handleLogin)
}

interface App {
  post(path: string, handler: unknown): void
}
declare const handleLogin: unknown
