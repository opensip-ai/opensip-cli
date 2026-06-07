// Clean fixture: a scope-owned registry constructed by a factory, plus the two
// ADR-0023-exempt run-scoped utilities (declared in their own files below).
// 0 findings.
export function createCheckRegistry(): CheckRegistry {
  return new CheckRegistry()
}

declare class CheckRegistry {}
