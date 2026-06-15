export function formatLabel(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? `[${trimmed}]` : '[empty]'
}
