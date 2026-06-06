export function shutdown(ok: boolean): void {
  if (!ok) {
    process.exit(1)
  }
}
