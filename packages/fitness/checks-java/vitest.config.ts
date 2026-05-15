import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/index.ts'],
    },
  },
});
