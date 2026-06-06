export function findUser(db: { query: (sql: string, params: unknown[]) => unknown }, userId: string): unknown {
  return db.query('SELECT id FROM users WHERE id = $1', [userId])
}
