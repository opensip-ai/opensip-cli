const validKeys = [process.env.API_KEY_CURRENT, process.env.API_KEY_PREVIOUS].filter(Boolean)

export function isValid(provided: string): boolean {
  return validKeys.includes(provided)
}
