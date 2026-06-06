interface IDisposable {
  dispose(): void
}

export class Connection implements IDisposable {
  open(): void {
    // opens a socket
  }
}
