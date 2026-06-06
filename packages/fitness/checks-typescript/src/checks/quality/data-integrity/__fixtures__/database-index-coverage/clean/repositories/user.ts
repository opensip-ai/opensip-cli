interface Db {
  query: (sql: string) => unknown[]
}

export class UserRepository {
  constructor(private readonly db: Db) {}

  recent(): unknown[] {
    return this.db.query('SELECT id, name FROM users ORDER BY id LIMIT 10')
  }
}
