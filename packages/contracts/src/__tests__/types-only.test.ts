/**
 * Structural guard: @opensip-cli/contracts is a public Tool↔runner facade, not
 * a host-runtime package. The `cli:` block loader (`loadCliDefaults`) — a
 * runtime YAML projection — moved to @opensip-cli/config in ADR-0023. This test
 * fails if any contracts source reintroduces config-document parsing
 * (a `readYamlFile(...)` / `resolveProjectConfigPath(...)` call),
 * complementing the `no-config-loader-outside-config` fitness guardrail.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Recursively collect .ts source files under contracts/src, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('@opensip-cli/contracts stays out of host runtime ownership', () => {
  const files = sourceFiles(SRC);

  it('discovers source files (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('contains no YAML→config projection call (readYamlFile / resolveProjectConfigPath)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // Match a CALL (identifier followed by `(`), not a mention in prose/strings.
      if (
        /\breadYamlFile(?:OrThrow)?\s*\(/.test(content) ||
        /\bresolveProjectConfigPath\s*\(/.test(content)
      ) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    expect(offenders, `contracts must not parse config: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no longer ships a cli-config module', () => {
    expect(files.some((f) => f.endsWith('cli-config.ts'))).toBe(false);
  });
});
