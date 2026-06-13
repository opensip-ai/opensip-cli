// VIOLATION: reads the parsed-options object by a kebab-case key. Commander
// camelCases long flags, so this key is always undefined (silent no-op flag).
export function handle(opts: Record<string, unknown>): boolean {
  return Boolean(opts['summary-only']);
}
