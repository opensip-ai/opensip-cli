/**
 * Parse concatenated top-level `--json` CLI outcome documents from stdout.
 *
 * The CLI pretty-prints each outcome object at column 0; multi-step runs emit
 * several documents back-to-back. Split before each line-leading `{`.
 */
export function parseCliJsonOutcomes(stdout: string): Record<string, unknown>[] {
  return stdout
    .split(/\n(?=\{)/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('{'))
    .map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
}