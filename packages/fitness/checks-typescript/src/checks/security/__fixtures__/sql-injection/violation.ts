export function findUser(db: { query: (sql: string) => unknown }, userId: string): unknown {
  return db.query(`SELECT id FROM users WHERE id = ${userId}`)
}
