export function start(server: Server): void {
  server.listen(3000)
}

interface Server {
  listen(port: number): void
}
