import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    forbidOnly: true,
    // Disallow .skip and .todo per Phase T Group T-E.
    allowOnly: false,
  },
});
