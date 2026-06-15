export function verify(apiKey: string, provided: string): boolean {
  // Timing-unsafe equality on a secret-bearing identifier
  if (apiKey === provided) {
    return true
  }
  return false
}
