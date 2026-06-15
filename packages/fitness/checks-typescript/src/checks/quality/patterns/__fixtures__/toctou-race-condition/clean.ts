interface Store {
  get: (id: string) => Promise<{ balance: number }>
  update: (id: string, value: { balance: number }, expectedVersion: number) => Promise<void>
}

export class Wallet {
  constructor(private readonly store: Store) {}

  async credit(id: string, amount: number): Promise<void> {
    const account = await this.store.get(id)
    await this.store.update(id, { balance: account.balance + amount }, expectedVersion)
  }
}

declare const expectedVersion: number
