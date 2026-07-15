import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HarnessPrerequisiteError,
  assertTargetRealpathStable,
  buildCliTarget,
  spawnCli,
  spawnProcess,
  tailForDiagnostics,
  validateInstalledEntrypoint,
  workspaceCliDistPath,
} from './spawn.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix = 'agent-eval-spawn-target-'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

describe('spawnProcess', () => {
  it('captures output and nonzero exits without throwing', async () => {
    const result = await spawnProcess(process.execPath, [
      '-e',
      "const fs=require('node:fs');fs.writeSync(1,'out');fs.writeSync(2,'err');globalThis['process'].exitCode=7",
    ]);
    expect(result).toMatchObject({
      exitCode: 7,
      outputLimitExceeded: false,
      stderr: 'err',
      stdout: 'out',
      timedOut: false,
    });
  });

  it('terminates a child that exceeds the time bound', async () => {
    const started = Date.now();
    const result = await spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('terminates and truncates a child that exceeds the output bound', async () => {
    const result = await spawnProcess(
      process.execPath,
      ['-e', "require('node:fs').writeSync(1,'x'.repeat(100000))"],
      { maxOutputBytes: 128 },
    );
    expect(result.outputLimitExceeded).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(128);
  });
});

describe('validateInstalledEntrypoint', () => {
  it('accepts a regular readable absolute JS bin and returns its realpath', () => {
    const root = temporaryDirectory();
    const entrypoint = join(root, 'index.js');
    writeFileSync(entrypoint, '#!/usr/bin/env node\n');
    expect(validateInstalledEntrypoint(entrypoint)).toBe(entrypoint);
  });

  it('resolves a symlinked JS bin to its regular-file realpath', () => {
    const root = temporaryDirectory();
    const real = join(root, 'real.mjs');
    writeFileSync(real, 'export default 1;\n');
    const link = join(root, 'link.mjs');
    symlinkSync(real, link);
    expect(validateInstalledEntrypoint(link)).toBe(real);
  });

  it.each([
    ['a relative path', 'packages/cli/dist/index.js'],
    ['a .cmd shim', '/abs/opensip.cmd'],
    ['a shell shim without a JS extension', '/abs/opensip'],
    ['a control character', '/abs/index\n.js'],
  ])('rejects %s', (_label, value) => {
    expect(() => validateInstalledEntrypoint(value)).toThrow(HarnessPrerequisiteError);
  });

  it('rejects a missing file', () => {
    const root = temporaryDirectory();
    expect(() => validateInstalledEntrypoint(join(root, 'absent.js'))).toThrow(
      HarnessPrerequisiteError,
    );
  });

  it('rejects a directory that carries a JS-looking name', () => {
    const root = temporaryDirectory();
    const directory = join(root, 'not-a-file.js');
    mkdirSync(directory);
    expect(() => validateInstalledEntrypoint(directory)).toThrow(HarnessPrerequisiteError);
  });

  it('rejects a symlink whose target resolves to a non-JS regular file', () => {
    const root = temporaryDirectory();
    const target = join(root, 'shim.cmd');
    writeFileSync(target, '@echo off\n');
    const link = join(root, 'opensip.js');
    symlinkSync(target, link);
    expect(() => validateInstalledEntrypoint(link)).toThrow(HarnessPrerequisiteError);
  });
});

describe('buildCliTarget', () => {
  it('builds a workspace target without asserting the dist exists', () => {
    const target = buildCliTarget();
    expect(target.source).toBe('workspace');
    expect(target.command).toBe(process.execPath);
    expect(target.entrypoint.endsWith('index.js')).toBe(true);
  });

  it('builds an immutable installed target from a verified entrypoint', () => {
    const root = temporaryDirectory();
    const entrypoint = join(root, 'index.js');
    writeFileSync(entrypoint, 'export default 1;\n');
    const target = buildCliTarget(entrypoint);
    expect(target).toEqual({
      command: process.execPath,
      entrypoint,
      source: 'installed',
    });
    expect(Object.isFrozen(target)).toBe(true);
  });
});

describe('assertTargetRealpathStable', () => {
  it('is a no-op for a workspace target', () => {
    expect(() => assertTargetRealpathStable(buildCliTarget())).not.toThrow();
  });

  it('passes when an installed entrypoint is unchanged', () => {
    const root = temporaryDirectory();
    const entrypoint = join(root, 'index.js');
    writeFileSync(entrypoint, 'export default 1;\n');
    expect(() => assertTargetRealpathStable(buildCliTarget(entrypoint))).not.toThrow();
  });

  it('rejects an installed entrypoint that vanished mid-run', () => {
    const root = temporaryDirectory();
    const entrypoint = join(root, 'index.js');
    writeFileSync(entrypoint, 'export default 1;\n');
    const target = buildCliTarget(entrypoint);
    rmSync(entrypoint);
    expect(() => assertTargetRealpathStable(target)).toThrow(/changed|unavailable/u);
  });

  it('rejects an installed entrypoint whose node is no longer a regular file mid-run', () => {
    const root = temporaryDirectory();
    const entrypoint = join(root, 'index.js');
    writeFileSync(entrypoint, 'export default 1;\n');
    const target = buildCliTarget(entrypoint);
    // Replace the regular file with a directory at the same path.
    rmSync(entrypoint);
    mkdirSync(entrypoint);
    expect(() => assertTargetRealpathStable(target)).toThrow(/changed|unavailable/u);
  });
});

describe('spawnCli target', () => {
  it('launches exactly the installed target entrypoint, never the workspace dist', async () => {
    const root = temporaryDirectory();
    // A fake installed JS bin that echoes the entrypoint the harness actually ran.
    const entrypoint = join(root, 'fake-opensip.js');
    writeFileSync(
      entrypoint,
      "const { argv } = require('node:process'); process.stdout.write(argv[1] ?? '');\n",
    );
    const target = buildCliTarget(entrypoint);

    const result = await spawnCli(['--version'], { cwd: root, target });
    expect(result.exitCode).toBe(0);
    // The child was launched with the installed entrypoint — not the workspace build.
    expect(result.stdout).toBe(realpathSync(entrypoint));
    expect(result.stdout).not.toBe(workspaceCliDistPath());
    expect(result.stdout).not.toContain('cli/dist/index.js');
  });
});

describe('tailForDiagnostics', () => {
  it('returns short text unchanged', () => {
    expect(tailForDiagnostics('short', 16)).toBe('short');
  });

  it('returns a marked UTF-8-bounded suffix', () => {
    const value = tailForDiagnostics(`prefix-${'é'.repeat(100)}`, 64);
    expect(value).toContain('[output truncated]');
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(64);
  });
});
