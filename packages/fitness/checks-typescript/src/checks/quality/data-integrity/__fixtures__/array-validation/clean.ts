export function sumFirst(values: number[]): number {
  if (!Array.isArray(values) || values.length < 2) {
    return 0
  }
  return values[0] + values[1]
}
