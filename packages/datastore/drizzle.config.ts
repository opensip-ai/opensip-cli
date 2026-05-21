import type { Config } from 'drizzle-kit';

export default {
  dialect: 'sqlite',
  schema: [],
  out: './migrations',
} satisfies Config;
