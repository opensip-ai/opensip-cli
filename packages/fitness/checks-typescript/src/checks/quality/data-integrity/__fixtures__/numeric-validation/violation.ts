export function toCount(raw: string): number {
  const parsed = parseInt(raw, 10)
  return parsed * 2
}
