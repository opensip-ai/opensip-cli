type Callback = (event: string) => void

export class Bus {
  private subscribers: Callback[] = []

  notify(event: string): void {
    this.subscribers.forEach((cb) => cb(event))
  }
}
