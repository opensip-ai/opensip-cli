import { store } from './store.js'

export async function getUser(id: string): Promise<unknown> {
  return store.db.select().from(users).where(eq(users.id, id))
}

declare const users: { id: unknown }
declare function eq(a: unknown, b: unknown): unknown
