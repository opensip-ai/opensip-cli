interface Db {
  put(id: string, name: string): Promise<void>
}

export class UserRepository {
  constructor(private readonly db: Db) {}

  async save(id: string, name: string): Promise<void> {
    await this.db.put(id, name)
  }
}
