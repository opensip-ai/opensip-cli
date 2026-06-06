import { timingSafeEqual } from 'node:crypto'

export function verify(apiKey: string, provided: string): boolean {
  const a = Buffer.from(apiKey)
  const b = Buffer.from(provided)
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}
