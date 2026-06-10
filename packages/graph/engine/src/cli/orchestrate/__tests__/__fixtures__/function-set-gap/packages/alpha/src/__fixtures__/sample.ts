// A check-pack fixture: under alpha's rootDir, but alpha/tsconfig.json
// excludes **/__fixtures__/**, so per-unit (sharded) discovery drops it.
export function alphaFixtureSubject(): number {
  return 2;
}
