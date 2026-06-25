import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunScope, runWithScope, runWithScopeSync } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { YagniConfigSchema } from '../cli/yagni-config-schema.js';
import { duplicateBodyCandidateDetector } from '../detectors/duplicate-body-candidate.js';
import { buildTsInventory } from '../lib/build-ts-inventory.js';

describe('yagni hardening (H1–H4)', () => {
  it('rejects unknown keys in the strict yagni config block (H1)', () => {
    expect(YagniConfigSchema.safeParse({ graphMode: 'build' }).success).toBe(false);
  });

  it('emits project-relative paths under the project root (H2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yagni-hardening-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(
        join(dir, 'src', 'sample.ts'),
        `export function secretFn() { return 'SECRET_TOKEN_abc123'; }\n`,
      );
      const scope = new RunScope();
      const candidates = runWithScopeSync(scope, () => buildTsInventory(dir));
      for (const c of candidates) {
        expect(c.filePath.startsWith('../')).toBe(false);
        expect(c.filePath.includes('..')).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never surfaces raw body source in logger events or signals (H4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yagni-secret-'));
    const secret = 'SECRET_TOKEN_abc123';
    const info = vi.fn();
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(
        join(dir, 'src', 'secret.ts'),
        `export function leak() { return '${secret}'; }\n`,
      );
      const scope = new RunScope({
        logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
      });
      const result = await runWithScope(scope, () =>
        duplicateBodyCandidateDetector.run({
          cwd: dir,
          config: {},
          graphCatalog: null,
          includeTests: true,
        }),
      );
      const logText = JSON.stringify(info.mock.calls);
      const signalText = JSON.stringify(result.signals);
      expect(logText).not.toContain(secret);
      expect(signalText).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
