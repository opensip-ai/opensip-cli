interface Db {
  query: (sql: string) => unknown[]
}

export class UserRepository {
  constructor(private readonly db: Db) {}

  all(): unknown[] {
    return this.db.query('SELECT * FROM users')
  }
}
