import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // vitest 4 tightened timing accounting; CI hardware
    // needs more headroom than the 5s default for slow-cohort tests.
    testTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    // Some checks (e.g. test-convention-consistency) keep sample `*.test.ts`
    // files under `__fixtures__/` as analysis inputs. They must NOT be
    // collected as real tests — exclude the fixture tree from discovery.
    exclude: [...configDefaults.exclude, 'src/**/__fixtures__/**'],
    coverage: {
      include: ['src/**'],
      // `__fixtures__/**` holds sample source files the checks analyze as
      // text — they are test data, never executed, so they must not count
      // toward code coverage (they only drag the denominator to 0%).
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/__fixtures__/**',
        'src/index.ts',
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
