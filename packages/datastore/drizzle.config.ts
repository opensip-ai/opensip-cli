import type { Config } from 'drizzle-kit';

export default {
  dialect: 'sqlite',
  schema: ['../contracts/src/persistence/schema/sessions.ts'],
  out: './migrations',
} satisfies Config;
