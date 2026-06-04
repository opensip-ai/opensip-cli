import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkEntitlement } from '@opensip-tools/reporting';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';


import type * as NodeOs from 'node:os';

// Mock the cloud entitlement check so the configure flow's key-verification
// step (audit P2-2) never hits the network in tests.
vi.mock('@opensip-tools/reporting', () => ({
  checkEntitlement: vi.fn(),
  DEFAULT_CLOUD_ENDPOINT: 'https://cloud.example',
}));
const checkEntitlementMock = checkEntitlement as unknown as MockInstance;

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
  checkEntitlementMock.mockReset();
  checkEntitlementMock.mockResolvedValue({ entitled: false });
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

  it('tests the key against the cloud entitlement endpoint after saving (P2-2)', async () => {
    nextAnswer = 'sk-saved-and-tested-1234';
    const { executeConfigure } = await loadModule();
    await executeConfigure();
    expect(checkEntitlementMock).toHaveBeenCalledTimes(1);
    expect(checkEntitlementMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-saved-and-tested-1234' }),
    );
  });
});

describe('verifyConfiguredKey (audit P2-2)', () => {
  it('reports an entitled key as verified, without leaking the raw key', async () => {
    checkEntitlementMock.mockResolvedValue({ entitled: true });
    const { verifyConfiguredKey } = await loadModule();
    const ok = await verifyConfiguredKey('sk-secret-9999');
    expect(ok).toBe(true);
    expect(writes.some((s) => s.includes('verified'))).toBe(true);
    expect(writes.join('')).not.toContain('sk-secret-9999');
  });

  it('warns (and returns false) when the key is invalid / not entitled / unreachable', async () => {
    checkEntitlementMock.mockResolvedValue({ entitled: false });
    const { verifyConfiguredKey } = await loadModule();
    const ok = await verifyConfiguredKey('sk-bad');
    expect(ok).toBe(false);
    expect(writes.some((s) => s.includes('Could not verify'))).toBe(true);
  });
});
