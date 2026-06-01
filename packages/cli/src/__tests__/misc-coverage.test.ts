/**
 * Targeted unit tests for small helpers whose only consumers are
 * subprocess or I/O entry points.
 *
 * Bundled into one file because each helper would otherwise warrant a
 * 5-line *.test.ts of its own:
 *
 *   - `formatInsideExistingProjectMessage` (init/state-machine.ts) — only
 *     called from inside `executeInit`'s discovery-refusal branch, which
 *     existing tests cover end-to-end via `executeInit`; no unit pins the
 *     message-shape contract directly.
 *   - `isValidTool` (bootstrap/validate-tool.ts) — runtime shape
 *     predicate for third-party tool exports; tested directly here to
 *     hit every reject branch without standing up a fake on-disk npm
 *     package.
 *   - default `write` fallback in `update-notifier.ts` — only fires when
 *     a real npm update is available (untestable in CI); we cover the
 *     branch by mocking `update-notifier` to report a stale version.
 *   - `defaultPrompt` + default `write` in `uninstall.ts` — the I/O
 *     fallbacks that exist for production but are bypassed in every
 *     other test via explicit `write` / `prompt` callbacks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isValidTool } from '../bootstrap/validate-tool.js';
import { formatInsideExistingProjectMessage } from '../commands/init/state-machine.js';

// --- state-machine.formatInsideExistingProjectMessage -------------------------

describe('formatInsideExistingProjectMessage', () => {
  it('includes the discovered root and the three corrective actions', () => {
    const msg = formatInsideExistingProjectMessage('/abs/path/to/proj');
    expect(msg).toContain('/abs/path/to/proj');
    expect(msg).toContain('--keep');
    expect(msg).toContain('--remove');
    expect(msg).toContain('--cwd .');
    expect(msg).toMatch(/already inside an opensip-tools project/i);
  });
});

// --- register-tools.isValidTool ----------------------------------------------

describe('isValidTool', () => {
  it('accepts a minimally well-formed tool', () => {
    expect(
      isValidTool({
        metadata: { id: 'fake' },
        register: () => undefined,
        commands: [],
      }),
    ).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isValidTool(null)).toBe(false);
    expect(isValidTool(undefined)).toBe(false);
    expect(isValidTool('tool')).toBe(false);
    expect(isValidTool(42)).toBe(false);
  });

  it('rejects when metadata is missing or non-object', () => {
    expect(isValidTool({ register: () => undefined, commands: [] })).toBe(false);
    expect(isValidTool({ metadata: null, register: () => undefined, commands: [] })).toBe(false);
    expect(isValidTool({ metadata: 'fake', register: () => undefined, commands: [] })).toBe(false);
  });

  it('rejects when metadata.id is missing or non-string', () => {
    expect(isValidTool({ metadata: {}, register: () => undefined, commands: [] })).toBe(false);
    expect(isValidTool({ metadata: { id: 123 }, register: () => undefined, commands: [] })).toBe(false);
  });

  it('rejects when register is missing or non-function', () => {
    expect(isValidTool({ metadata: { id: 'x' }, commands: [] })).toBe(false);
    expect(isValidTool({ metadata: { id: 'x' }, register: 'nope', commands: [] })).toBe(false);
  });

  it('rejects when commands is missing or non-array', () => {
    expect(isValidTool({ metadata: { id: 'x' }, register: () => undefined })).toBe(false);
    expect(isValidTool({ metadata: { id: 'x' }, register: () => undefined, commands: {} })).toBe(false);
  });
});

// --- update-notifier default write fallback -----------------------------------

describe('update-notifier default write fallback', () => {
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    delete process.env.OPENSIP_NO_UPDATE;
    delete process.env.NO_UPDATE_NOTIFIER;
    delete process.env.CI;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('writes the "update available" line to stderr when no `write` override is given', async () => {
    // Force a TTY so the early-skip doesn't fire.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    // Mock update-notifier to report a stale-version update synchronously.
    vi.resetModules();
    vi.doMock('update-notifier', () => ({
      default: () => ({
        update: { current: '0.0.1', latest: '9.9.9', type: 'major' },
      }),
    }));

    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    try {
      const { maybeNotify } = await import('../update-notifier.js');
      maybeNotify({ name: 'opensip-tools', version: '0.0.1' });
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).toMatch(/0\.0\.1.*9\.9\.9/);
    expect(writes.join('')).toContain('npm install -g opensip-tools');
  });
});

// --- uninstall.ts default fallbacks ------------------------------------------

describe('uninstall.ts — default I/O fallbacks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses process.stdout.write when no `write` override is supplied', async () => {
    // Run executeUninstall against a non-existent userRoot so it bails on
    // the empty-target branch which calls `write(note)`. With no `write`
    // override, the fallback `process.stdout.write` is exercised.
    const { executeUninstall } = await import('../commands/uninstall.js');
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      writes.push(String(c));
      return true;
    });
    try {
      await executeUninstall({
        rootDir: '/definitely/does/not/exist/opensip-fallback-test',
        yes: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).toMatch(/Nothing to remove/);
  });

  it('defaultPrompt opens a readline interface and resolves with the typed answer', async () => {
    // Stub readline so we don't need real TTY interaction. We pass our own
    // prompt to `executeUninstall` in every other test; this test invokes
    // the unstubbed path to cover `defaultPrompt`.
    vi.resetModules();
    vi.doMock('node:readline/promises', () => ({
      createInterface: () => ({
        question: () => Promise.resolve('n'),
        close: () => undefined,
      }),
    }));

    // mock a user root that exists so we reach the confirmation prompt
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-defaultprompt-'));
    fs.writeFileSync(path.join(dir, 'config.yml'), 'apiKey: x\n', 'utf8');

    const { executeUninstall } = await import('../commands/uninstall.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = await executeUninstall({ rootDir: dir });
      // 'n' from the stubbed readline → cancelled.
      expect(result.action).toBe('cancelled');
    } finally {
      writeSpy.mockRestore();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
