import { sql } from 'drizzle-orm'

export const up = sql`DROP TABLE legacy_users`
