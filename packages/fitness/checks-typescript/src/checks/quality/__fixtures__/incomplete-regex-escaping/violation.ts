export function escapeInput(input: string): string {
  return input.replace(/[a-z]/g, '\\$&')
}
