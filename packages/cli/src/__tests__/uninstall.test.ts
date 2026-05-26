/**
 * Tests for `executeUninstall` — covers both user-level mode (default)
 * and project-local mode (`--project`).
 *
 * Each test uses a per-test tmp dir so nothing in the real `~/.opensip-tools`
 * or any real project is ever touched. The `write` and `prompt` hooks let
 * us assert on output and drive the confirmation flow deterministically.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { executeUninstall } from '../commands/uninstall.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `uninstall-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a captured-output writer that also exposes the accumulated text. */
function captureWrite(): { write: (s: string) => void; text: () => string } {
  let buf = '';
  return { write: (s) => { buf += s; }, text: () => buf };
}

/** Discard sink for tests that don't care about output. */
function noop(_s: string): void {
  // intentional no-op
}

describe('executeUninstall — user mode', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = makeTempDir();
    writeFileSync(join(rootDir, 'config.yml'), 'apiKey: secret\n', 'utf8');
  });

  afterEach(() => {
    try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('removes the user-level root dir when confirmed', async () => {
    const out = captureWrite();
    const result = await executeUninstall({
      rootDir,
      yes: true,
      write: out.write,
    });

    expect(result.type).toBe('uninstall-done');
    expect(result.mode).toBe('user');
    expect(result.action).toBe('removed');
    expect(result.removed).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(existsSync(rootDir)).toBe(false);
    // The pre-prompt target list still surfaces through the write sink.
    expect(out.text()).toContain(rootDir);
  });

  it('dry-run does not remove anything', async () => {
    const out = captureWrite();
    const result = await executeUninstall({
      rootDir,
      dryRun: true,
      write: out.write,
    });

    expect(result.action).toBe('dry-run');
    expect(result.removed).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(existsSync(rootDir)).toBe(true);
    // Targets list still surfaces pre-prompt; the [dry-run] outcome
    // moved to the Ink renderer so the result discriminator is
    // canonical here.
    expect(out.text()).toContain(rootDir);
  });

  it('reports nothing to remove when root does not exist', async () => {
    rmSync(rootDir, { recursive: true, force: true });
    const out = captureWrite();
    const result = await executeUninstall({
      rootDir,
      yes: true,
      write: out.write,
    });

    expect(result.removed).toBe(false);
    expect(result.targets).toHaveLength(0);
    expect(out.text()).toContain('Nothing to remove');
  });

  it('cancels when prompt declines', async () => {
    const out = captureWrite();
    const result = await executeUninstall({
      rootDir,
      write: out.write,
      prompt: () => Promise.resolve('n'),
    });

    expect(result.action).toBe('cancelled');
    expect(result.cancelled).toBe(true);
    expect(result.removed).toBe(false);
    expect(existsSync(rootDir)).toBe(true);
    // Cancelled outcome is rendered by Ink; pre-prompt target list
    // still surfaces via the write sink.
    expect(out.text()).toContain(rootDir);
  });
});

describe('executeUninstall — project mode', () => {
  let projectDir: string;
  let userSourceDir: string;
  let runtimeDir: string;
  let configFile: string;

  beforeEach(() => {
    projectDir = makeTempDir();
    userSourceDir = join(projectDir, 'opensip-tools');
    runtimeDir = join(userSourceDir, '.runtime');
    configFile = join(projectDir, 'opensip-tools.config.yml');
    mkdirSync(join(userSourceDir, 'fit', 'checks'), { recursive: true });
    mkdirSync(join(runtimeDir, 'logs'), { recursive: true });
    writeFileSync(join(userSourceDir, 'fit', 'checks', 'custom.mjs'), '// custom check\n', 'utf8');
    writeFileSync(join(runtimeDir, 'logs', 'run.jsonl'), '{}\n', 'utf8');
    writeFileSync(configFile, 'targets: []\n', 'utf8');
  });

  afterEach(() => {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('default (no --purge): safe-by-default', () => {
    it('removes ONLY .runtime/; preserves user content + config', async () => {
      const out = captureWrite();
      const result = await executeUninstall({
        project: projectDir,
        yes: true,
        write: out.write,
      });

      expect(result.mode).toBe('project');
      expect(result.removed).toBe(true);
      // Only the runtime target was deleted.
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].path).toBe(runtimeDir);
      expect(existsSync(runtimeDir)).toBe(false);
      // User content + config preserved.
      expect(existsSync(join(userSourceDir, 'fit', 'checks', 'custom.mjs'))).toBe(true);
      expect(existsSync(configFile)).toBe(true);
      // Project dir untouched.
      expect(existsSync(projectDir)).toBe(true);
    });

    it("prints the 'KEPT' section listing preserved user content", async () => {
      const out = captureWrite();
      await executeUninstall({
        project: projectDir,
        yes: true,
        write: out.write,
      });
      const text = out.text();
      expect(text).toContain('This will remove (rebuildable runtime state only)');
      expect(text).toContain('These will be KEPT');
      expect(text).toContain('opensip-tools.config.yml');
      expect(text).toContain('--purge');
    });

    it('reports "empty" + KEPT section when .runtime/ is already absent', async () => {
      rmSync(runtimeDir, { recursive: true, force: true });
      const out = captureWrite();
      const result = await executeUninstall({
        project: projectDir,
        yes: true,
        write: out.write,
      });
      expect(result.action).toBe('empty');
      expect(out.text()).toContain('Nothing to remove — runtime state is already absent');
      expect(out.text()).toContain('These will be KEPT');
    });
  });

  describe('--purge: destructive', () => {
    it('removes EVERYTHING when --purge is passed', async () => {
      const out = captureWrite();
      const result = await executeUninstall({
        project: projectDir,
        purge: true,
        yes: true,
        write: out.write,
      });

      expect(result.removed).toBe(true);
      expect(existsSync(runtimeDir)).toBe(false);
      expect(existsSync(join(userSourceDir, 'fit', 'checks', 'custom.mjs'))).toBe(false);
      expect(existsSync(configFile)).toBe(false);
      expect(existsSync(projectDir)).toBe(true);
    });

    it('prints the destructive warning + git-status hint', async () => {
      const out = captureWrite();
      await executeUninstall({
        project: projectDir,
        purge: true,
        yes: true,
        write: out.write,
      });
      const text = out.text();
      expect(text).toContain('⚠ This removes EVERYTHING');
      expect(text).toContain('git status');
    });

    it('removes only present buckets when some are absent (--purge)', async () => {
      rmSync(configFile);
      rmSync(runtimeDir, { recursive: true, force: true });
      const result = await executeUninstall({
        project: projectDir,
        purge: true,
        yes: true,
        write: noop,
      });
      // Only the user-content entries remain.
      expect(result.targets.length).toBeGreaterThan(0);
      expect(result.targets.every((t) => t.path.startsWith(userSourceDir))).toBe(true);
    });
  });

  it('refuses to run when no opensip-tools state exists at the resolved path', async () => {
    rmSync(userSourceDir, { recursive: true, force: true });
    rmSync(configFile);
    const out = captureWrite();
    const result = await executeUninstall({
      project: projectDir,
      yes: true,
      write: out.write,
    });

    expect(result.removed).toBe(false);
    expect(result.targets).toHaveLength(0);
    expect(out.text()).toContain('Nothing to remove');
    expect(out.text()).toContain('no opensip-tools state');
  });

  it('uses cwd override when --project is passed without a value', async () => {
    const out = captureWrite();
    const result = await executeUninstall({
      project: true,
      cwd: projectDir,
      yes: true,
      write: out.write,
    });

    expect(result.mode).toBe('project');
    expect(result.removed).toBe(true);
    // Default mode still: only .runtime/ removed.
    expect(existsSync(runtimeDir)).toBe(false);
    expect(existsSync(join(userSourceDir, 'fit', 'checks', 'custom.mjs'))).toBe(true);
  });

  it('result mode discriminates between user and project uninstalls', async () => {
    const result = await executeUninstall({
      project: projectDir,
      yes: true,
      write: noop,
    });
    expect(result.mode).toBe('project');
    expect(result.action).toBe('removed');
  });
});
