export function loadConfigJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}