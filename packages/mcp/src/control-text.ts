/** Shared Unicode control-character validation/sanitization for MCP boundaries. */

export function hasControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}
