export async function save(db: Db): Promise<void> {
  await db.beginTransaction()
  await db.insert(row)
}

interface Db {
  beginTransaction(): Promise<void>
  insert(value: unknown): Promise<void>
}
declare const row: unknown
