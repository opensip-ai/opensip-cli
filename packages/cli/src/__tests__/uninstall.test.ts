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
  let configFile: string;

  beforeEach(() => {
    projectDir = makeTempDir();
    userSourceDir = join(projectDir, 'opensip-tools');
    configFile = join(projectDir, 'opensip-tools.config.yml');
    mkdirSync(join(userSourceDir, 'fit', 'checks'), { recursive: true });
    writeFileSync(join(userSourceDir, 'fit', 'checks', 'custom.mjs'), '// custom check\n', 'utf8');
    writeFileSync(configFile, 'targets: []\n', 'utf8');
  });

  afterEach(() => {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('removes both opensip-tools/ and opensip-tools.config.yml when both exist', async () => {
    const out = captureWrite();
    const result = await executeUninstall({
      project: projectDir,
      yes: true,
      write: out.write,
    });

    expect(result.mode).toBe('project');
    expect(result.removed).toBe(true);
    expect(result.targets).toHaveLength(2);
    expect(existsSync(userSourceDir)).toBe(false);
    expect(existsSync(configFile)).toBe(false);
    // Project dir itself must remain — we only touch our own state.
    expect(existsSync(projectDir)).toBe(true);
  });

  it('removes only the dir when config file is absent', async () => {
    rmSync(configFile);
    const result = await executeUninstall({
      project: projectDir,
      yes: true,
      write: noop,
    });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].path).toBe(userSourceDir);
    expect(result.targets[0].kind).toBe('dir');
  });

  it('removes only the config file when opensip-tools/ is absent', async () => {
    rmSync(userSourceDir, { recursive: true, force: true });
    const result = await executeUninstall({
      project: projectDir,
      yes: true,
      write: noop,
    });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].path).toBe(configFile);
    expect(result.targets[0].kind).toBe('file');
  });

  it('refuses to run when neither target exists at the resolved path', async () => {
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
    expect(existsSync(userSourceDir)).toBe(false);
  });

  it('warns about user-authored content in project mode', async () => {
    const out = captureWrite();
    await executeUninstall({
      project: projectDir,
      yes: true,
      write: out.write,
    });

    expect(out.text()).toContain('user-authored content');
  });

  it('result mode discriminates between user and project uninstalls', async () => {
    // The next-step hint moved to the Ink renderer (App.tsx); the
    // structured result is what tests assert on now. The renderer keys
    // off `mode` to pick between "npm uninstall -g …" (user) and
    // "opensip-tools uninstall" (project).
    const result = await executeUninstall({
      project: projectDir,
      yes: true,
      write: noop,
    });
    expect(result.mode).toBe('project');
    expect(result.action).toBe('removed');
  });
});
