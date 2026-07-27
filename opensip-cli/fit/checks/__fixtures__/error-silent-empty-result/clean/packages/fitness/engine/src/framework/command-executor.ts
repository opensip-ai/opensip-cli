/**
 * CLEAN fixture — failure results that ARE distinguishable, plus an
 * errno-narrowed catch that rethrows.
 *
 * Shapes taken from real, correct code in this repo:
 *   - `packages/fitness/engine/src/framework/command-executor.ts` returns
 *     `{ violations: [], error: 'Failed to parse command output: …' }` — the
 *     empty findings array is honest because the caller can branch on `error`.
 *   - `packages/agent-eval/src/adapters/opensip-mcp-protocol.ts` returns
 *     `{ failure: { code, kind, message }, truncated: false }` — `truncated:
 *     false` is fine because the literal carries a `failure` discriminator.
 *   - The `if (code === 'ENOENT') return …; throw error;` idiom is precise
 *     handling, not a swallow.
 *   - A settled batch that accounts for its rejected half.
 *   - A swallow the repo has already reviewed and annotated `@swallow-ok`.
 *
 * Expected: ZERO findings.
 */
import * as fs from 'node:fs/promises';

interface Violation {
  readonly message: string;
}

interface CommandResult {
  readonly violations: readonly Violation[];
  readonly exitCode: number;
  readonly error?: string;
}

interface ProtocolResult {
  readonly rendered: string;
  readonly truncated: boolean;
  readonly failure?: { readonly code: string; readonly message: string };
}

declare function parseOutput(stdout: string): Violation[];

export function runAndParse(stdout: string, exitCode: number): CommandResult {
  let violations: Violation[];
  try {
    violations = parseOutput(stdout);
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    return { violations: [], exitCode, error: `Failed to parse command output: ${message}` };
  }
  return { violations, exitCode };
}

export function decodeProtocol(rendered: string): ProtocolResult {
  try {
    JSON.parse(rendered);
  } catch {
    return {
      rendered,
      truncated: false,
      failure: { code: 'invalid-mcp-json', message: 'tool returned invalid JSON text' },
    };
  }
  return { rendered, truncated: false };
}

export async function statOrRethrow(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function loadAll(
  paths: readonly string[],
): Promise<{ contents: string[]; dropped: number; reasons: string[] }> {
  const contents: string[] = [];
  const reasons: string[] = [];
  const results = await Promise.allSettled(paths.map((p) => fs.readFile(p, 'utf8')));
  for (const result of results) {
    if (result.status === 'fulfilled') {
      contents.push(result.value);
      continue;
    }
    reasons.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
  }
  return { contents, dropped: reasons.length, reasons };
}

export function readOptionalIds(raw: string): string[] {
  const ids: string[] = [];
  try {
    for (const id of JSON.parse(raw) as string[]) ids.push(id);
  } catch {
    // @swallow-ok probe/optional capability: an unparsable optional block
    // contributes no ids, and the caller's own required-input validation
    // already fails closed on the absence.
    return ids;
  }
  return ids;
}
