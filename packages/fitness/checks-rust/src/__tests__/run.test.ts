/**
 * @fileoverview Execute the check end-to-end so the closures inside the
 * `defineCheck({...})` config (specifically `analyze`) are invoked.
 *
 * The pure analyzer is exercised by `no-dbg-macro.test.ts`. This file's
 * purpose is execution coverage for the un-called closures declared
 * inside the check definition.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LanguageRegistry, runWithScope } from '@opensip-cli/core';
import { makeFitnessTestScope } from '@opensip-cli/test-support';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { noDbgMacro } from '../checks/no-dbg-macro.js';

// applyContentFilter resolves the file's adapter via `currentScope()?.languages`
// (default registry global was removed in T1 cleanup). With no adapter
// registered for `.rs`, applyContentFilter falls through to raw content.
// Wrap the call in a scope that also carries fitness.fileCache, since check.run
// resolves the per-run cache from currentScope()?.fitness?.fileCache now
// (parallel-tool-invocations Phase 1).
const emptyScope = makeFitnessTestScope({ languages: new LanguageRegistry() });

let cwd: string;
let target: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opensip-checks-rust-cov-'));
  target = join(cwd, 'main.rs');
  writeFileSync(target, ['fn main() {', '    let x = 42;', '    dbg!(x);', '}', ''].join('\n'));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('noDbgMacro.run() execution coverage', () => {
  it('runs end-to-end against a Rust fixture with a dbg!() call', async () => {
    const result = await runWithScope(emptyScope, () =>
      noDbgMacro.run(cwd, { targetFiles: [target] }),
    );

    expect(result).toBeDefined();
    expect(Array.isArray(result.signals)).toBe(true);
    expect(typeof result.errors).toBe('number');
    expect(typeof result.warnings).toBe('number');
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('exposes a stable check config (slug/analysisMode/tags)', () => {
    expect(noDbgMacro.config.slug).toBe('rust-no-dbg-macro');
    expect(noDbgMacro.config.analysisMode).toBe('analyze');
    expect(noDbgMacro.config.tags).toContain('rust');
  });
});
