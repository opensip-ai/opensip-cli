const API_KEY = process.env.API_KEY

export function isValid(provided: string): boolean {
  return provided === API_KEY
}
