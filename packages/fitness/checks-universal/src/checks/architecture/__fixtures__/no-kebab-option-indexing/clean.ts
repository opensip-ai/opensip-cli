// CLEAN: reads the camelCased key Commander actually sets. Should produce 0 findings.
export function handle(opts: { summaryOnly?: boolean }): boolean {
  return Boolean(opts.summaryOnly);
}
