export function toCount(raw: string): number {
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed)) {
    return 0
  }
  return parsed * 2
}
