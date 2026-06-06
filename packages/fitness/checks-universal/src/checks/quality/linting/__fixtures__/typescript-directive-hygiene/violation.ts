export function widen(value: unknown): string {
  // @ts-expect-error
  return value.toLabel()
}
