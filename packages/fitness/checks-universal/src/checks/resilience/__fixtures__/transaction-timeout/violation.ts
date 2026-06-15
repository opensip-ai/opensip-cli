export async function save(qr: QueryRunner): Promise<void> {
  await qr.startTransaction()
  await qr.commit()
}

interface QueryRunner {
  startTransaction(): Promise<void>
  commit(): Promise<void>
}
