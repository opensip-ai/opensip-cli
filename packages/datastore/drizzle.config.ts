import type { Config } from 'drizzle-kit';

export default {
  dialect: 'sqlite',
  schema: [
    '../contracts/src/persistence/schema/sessions.ts',
    '../graph/engine/src/persistence/schema.ts',
  ],
  out: './migrations',
} satisfies Config;
