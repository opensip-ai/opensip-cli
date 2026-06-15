export class Store {
  private entries: Map<string, number> = new Map()

  put(key: string, value: number): void {
    this.entries.set(key, value)
  }

  drop(key: string): void {
    this.entries.delete(key)
  }
}
