interface IDisposable {
  dispose(): void
}

export class Connection implements IDisposable {
  private socket: { close: () => void } | null = null

  open(): void {
    this.socket = { close: () => undefined }
  }

  dispose(): void {
    this.socket?.close()
    this.socket = null
  }
}
