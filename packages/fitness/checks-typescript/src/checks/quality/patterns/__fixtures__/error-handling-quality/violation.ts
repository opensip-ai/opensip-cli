export function loadConfigJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

type Result<T> = { ok: true; value: T } | { ok: false; error: Error }

// Native bare-union Result error silently discarded — no log, no propagation,
// no marker (should be flagged).
export function firstLine(read: () => Result<string>): string | undefined {
  const result = read()
  if (!result.ok) return undefined
  return result.value.split('\n')[0]
}
