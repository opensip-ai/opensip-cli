export function start(server: Server): void {
  server.listen(3000)
  process.on('SIGTERM', () => {
    server.close()
  })
}

interface Server {
  listen(port: number): void
  close(): void
}
