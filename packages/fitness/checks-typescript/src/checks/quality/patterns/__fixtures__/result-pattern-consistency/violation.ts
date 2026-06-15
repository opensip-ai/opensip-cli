class ValidationError extends Error {}

export function applyName(name: string): string {
  if (name.length === 0) {
    throw new ValidationError('name is required')
  }
  return name
}
