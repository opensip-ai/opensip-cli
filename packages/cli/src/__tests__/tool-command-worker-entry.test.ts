/**
 * tool-command-worker-entry — unit coverage for the WORKER-side core of the
 * ADR-0054 dispatch plane (`runToolCommandWorker`), exercised IN-PROCESS (no
 * fork) so coverage instrumentation observes it. The forked end-to-end boundary
 * is proven separately in `external-tool-dispatch.test.ts`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exitScope } from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { runToolCommandWorker } from '../bootstrap/tool-command-worker-entry.js';

import type { ToolCommandWorkerSpec } from '../bootstrap/tool-command-dispatch-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'external-dispatch-tool');

function writeSpec(spec: ToolCommandWorkerSpec): string {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-worker-unit-'));
  const p = join(dir, 'spec.json');
  writeFileSync(p, JSON.stringify(spec), 'utf8');
  return p;
}

function specFor(overrides: Partial<ToolCommandWorkerSpec> = {}): ToolCommandWorkerSpec {
  return {
    toolId: 'external-dispatch-tool',
    toolPackageDir: FIXTURE_DIR,
    source: 'installed',
    commandName: 'ext-run',
    opts: { mode: 'ok' },
    positionals: [],
    ...overrides,
  };
}

describe('runToolCommandWorker', () => {
  afterEach(() => {
    // The worker enters a scope for the handler; pop it so tests do not leak.
    try {
      exitScope();
    } catch {
      /* no scope entered on the error paths */
    }
  });

  it('runs the handler and returns its recorded final-result (FRR seams)', async () => {
    const msg = await runToolCommandWorker(writeSpec(specFor({ opts: { mode: 'ok', echo: 'x' } })));
    expect(msg.kind).toBe('result');
    if (msg.kind !== 'result') throw new Error('expected result');
    expect(msg.value.output).toBe('signal-envelope');
    const env = msg.value.envelope as { tool: string; signals: { echoedOpt: string }[] };
    expect(env.tool).toBe('external-dispatch-tool');
    expect(env.signals[0]?.echoedOpt).toBe('x');
    expect(msg.value.exitCode).toBe(0);
  });

  it('returns a bad-spec error for an unreadable spec file', async () => {
    const msg = await runToolCommandWorker(join(tmpdir(), 'does-not-exist-12345.json'));
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('bad-spec');
  });

  it('returns runtime-load-failed when the package dir has no tool runtime', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'opensip-worker-empty-'));
    const msg = await runToolCommandWorker(writeSpec(specFor({ toolPackageDir: emptyDir })));
    rmSync(emptyDir, { recursive: true, force: true });
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('runtime-load-failed');
  });

  it('returns command-not-found for an unknown command name', async () => {
    const msg = await runToolCommandWorker(writeSpec(specFor({ commandName: 'nope' })));
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('command-not-found');
  });

  it('returns tool-handler-throw when the handler throws', async () => {
    const msg = await runToolCommandWorker(writeSpec(specFor({ opts: { mode: 'throw' } })));
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('tool-handler-throw');
    expect(msg.message).toContain('external handler boom');
    expect(msg.stack).toBeTypeOf('string');
  });

  it('fails loud (unsupported-seam) when the handler calls a host-only live-view seam', async () => {
    const msg = await runToolCommandWorker(writeSpec(specFor({ opts: { mode: 'live-seam' } })));
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('unsupported-seam');
    expect(msg.message).toContain("seam 'registerLiveView'");
  });
});
