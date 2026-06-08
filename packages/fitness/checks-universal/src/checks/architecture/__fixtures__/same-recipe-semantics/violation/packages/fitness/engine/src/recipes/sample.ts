export function runOne(fn: () => void): void {
  // Reimplements a per-unit timeout instead of the shared substrate.
  setTimeout(fn, 1000)
}
