import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as NodeOs from 'node:os';

let HOME: string;
let nextAnswer: string;
let writes: string[];

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => HOME,
  };
});

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(nextAnswer),
    close: () => { /* no-op for tests */ },
  }),
}));

async function loadModule() {
  return await import('../commands/configure.js');
}

beforeEach(() => {
  HOME = mkdtempSync(join(tmpdir(), 'opensip-configure-test-'));
  writes = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: unknown) => {
    writes.push(String(s));
    return true;
  });
  // Restore in afterEach.
  (globalThis as { __origStdoutWrite?: typeof origWrite }).__origStdoutWrite = origWrite;
  vi.resetModules();
});

afterEach(() => {
  const origWrite = (globalThis as { __origStdoutWrite?: typeof process.stdout.write })
    .__origStdoutWrite;
  if (origWrite) process.stdout.write = origWrite;
  rmSync(HOME, { recursive: true, force: true });
});

describe('executeConfigure', () => {
  it('returns "cancelled" when the user provides an empty answer', async () => {
    nextAnswer = '';
    const { executeConfigure } = await loadModule();
    const result = await executeConfigure();
    expect(result.action).toBe('cancelled');
    expect(result.configPath).toContain('config.yml');
  });

  it('saves the supplied API key and returns the masked value', async () => {
    nextAnswer = 'sk-supersecret-123456';
    const { executeConfigure } = await loadModule();
    const result = await executeConfigure();
    expect(result.action).toBe('saved');
    expect(result.maskedKey).toBe('sk-s...3456');
  });

  it('emits the "current key" hint when one is already stored', async () => {
    nextAnswer = 'first-key-with-mask-1234';
    let mod = await loadModule();
    await mod.executeConfigure();

    writes.length = 0;
    nextAnswer = 'second-key-with-mask-9876';
    vi.resetModules();
    mod = await loadModule();
    await mod.executeConfigure();
    const hint = writes.find((s) => s.includes('Current API key:'));
    expect(hint).toBeDefined();
  });

  it('does not mask short keys', async () => {
    nextAnswer = 'short';
    const { executeConfigure } = await loadModule();
    const result = await executeConfigure();
    expect(result.action).toBe('saved');
    // Keys <= 8 chars round-trip verbatim.
    expect(result.maskedKey).toBe('short');
  });
});
