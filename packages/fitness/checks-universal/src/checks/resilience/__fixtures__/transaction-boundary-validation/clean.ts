export async function save(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(row)
  })
}

interface Db {
  transaction(fn: (tx: Tx) => Promise<void>): Promise<void>
}
interface Tx {
  insert(value: unknown): Promise<void>
}
declare const row: unknown
