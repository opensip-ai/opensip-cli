import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      include: [
        'src/lib/**',
        'src/types/signal.ts',
        'src/index.ts',
      ],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    },
  },
});
