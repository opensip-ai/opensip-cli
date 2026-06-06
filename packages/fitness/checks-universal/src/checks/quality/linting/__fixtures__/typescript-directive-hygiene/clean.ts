export function widen(value: unknown): string {
  // @ts-expect-error -- upstream types omit the toLabel method that exists at runtime
  return value.toLabel()
}
