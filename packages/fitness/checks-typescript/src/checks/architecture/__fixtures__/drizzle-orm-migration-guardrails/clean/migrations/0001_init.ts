import { sql } from 'drizzle-orm'

export const up = sql`CREATE TABLE users (id text primary key, name text not null)`
