// Fixture: a package-root vitest config that satisfies the check.
export default {
  test: {
    coverage: {
      thresholds: { statements: 95, functions: 95, lines: 95, branches: 85 },
    },
  },
}
