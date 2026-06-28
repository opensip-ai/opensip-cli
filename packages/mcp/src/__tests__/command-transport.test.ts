/**
 * `opensip mcp` is a TRANSPORT, not a run (Task 6.1 §Observability).
 *
 * - It owns stdout for JSON-RPC: `output: 'raw-stream'` + `rawStreamReason:
 *   'mcp-stdio'`, project-scoped.
 * - It records NO session: the command returns no `ToolSessionContribution`, and
 *   MCP source never names `SessionRepo` / a `persist*Session` / a
 *   `runSession.record` writer (host-owned-run-timing). Verified structurally
 *   across the whole package source (the same symbols the dogfood self-checks
 *   forbid — asserted here as an explicit unit, not just at CI).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mcpCommandSpec } from '../command.js';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Every production `.ts` under `src/` (excludes `__tests__/` and `*.test.ts`). */
function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...productionSources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('mcp command — raw-stream transport contract', () => {
  it('owns stdout for JSON-RPC via the documented raw-stream escape hatch', () => {
    expect(mcpCommandSpec.output).toBe('raw-stream');
    expect(mcpCommandSpec.rawStreamReason).toBe('mcp-stdio');
    expect(mcpCommandSpec.scope).toBe('project');
  });
});

describe('mcp source — no session-record writer (transport, not a run)', () => {
  const sources = productionSources(SRC_DIR);
  const contents = new Map(sources.map((f) => [f, readFileSync(f, 'utf8')]));

  it('discovers the production source set', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it('never USES SessionRepo (reads sessions only through the read API; prose mentions are fine)', () => {
    // The host-owned-run-timing invariant forbids importing/instantiating the
    // writer — not naming it in a doc-comment that explains the constraint.
    const offenders = [...contents]
      .filter(
        ([, c]) => /\bnew\s+SessionRepo\b/.test(c) || /import[^;]*\bSessionRepo\b[^;]*from/.test(c),
      )
      .map(([f]) => f);
    expect(
      offenders,
      `SessionRepo must not be imported/instantiated:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('never returns a ToolSessionContribution or calls a session writer', () => {
    const forbidden = ['ToolSessionContribution', 'persistSession', 'runSession.record'];
    for (const needle of forbidden) {
      const offenders = [...contents].filter(([, c]) => c.includes(needle)).map(([f]) => f);
      expect(
        offenders,
        `${needle} must not appear in MCP source:\n${offenders.join('\n')}`,
      ).toEqual([]);
    }
  });
});
