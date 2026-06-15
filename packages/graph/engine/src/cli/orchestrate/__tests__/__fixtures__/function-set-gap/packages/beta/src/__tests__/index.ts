// A test file: under beta's rootDir, but beta/tsconfig.json excludes
// **/__tests__/** + **/*.test.ts, so per-unit (sharded) discovery drops it.
export function betaTestSubject(): number {
  return 4;
}
