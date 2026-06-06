type Callback = (event: string) => void

export class Bus {
  private subscribers: Callback[] = []

  notify(event: string): void {
    for (const cb of this.subscribers) {
      this.safeInvoke(cb, event)
    }
  }

  private safeInvoke(cb: Callback, event: string): void {
    try {
      cb(event)
    } catch {
      // isolate subscriber failures
    }
  }
}
