import type { Config } from 'drizzle-kit';

export default {
  dialect: 'sqlite',
  schema: [
    '../session-store/src/schema/sessions.ts',
    '../graph/engine/src/persistence/schema.ts',
    '../fitness/engine/src/persistence/schema.ts',
    './src/schema/baseline.ts',
  ],
  out: './migrations',
} satisfies Config;
