import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    forbidOnly: true,
    // Disallow .skip and .todo per Phase T Group T-E.
    allowOnly: false,
    coverage: {
      include: ['src/**'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        // Pure type-definition files — no executable code.
        'src/**/types.ts',
        // Top-level barrel — re-exports only.
        'src/index.ts',
        // Bootstrap module — registers adapters; entirely side-effect at import-time
        // and tested via the lang-adapter-registry tests.
        'src/bootstrap.ts',
      ],
    },
  },
});
