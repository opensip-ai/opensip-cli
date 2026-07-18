import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HarnessPrerequisiteError,
  MAX_INSTALLED_ENTRYPOINT_BYTES,
  MAX_INSTALLED_PACKAGE_JSON_BYTES,
  assertTargetFinalStable,
  assertTargetRealpathStable,
  buildCliTarget as buildCliTargetImpl,
  cleanupCliTarget,
  installedEntrypointOpenFlags,
  spawnCli,
  spawnProcess,
  tailForDiagnostics,
  validateInstalledEntrypoint,
  workspaceCliDistPath,
} from './spawn.js';

import type { CliTarget } from './spawn.js';

const temporaryRoots: string[] = [];
const temporaryTargets: CliTarget[] = [];
const temporaryAmbientPackages: string[] = [];

function buildCliTarget(entrypoint?: string): CliTarget {
  const target = buildCliTargetImpl(entrypoint);
  temporaryTargets.push(target);
  return target;
}

/** Wait for process-table reaping after SIGKILL (not instantaneous on loaded CI). */
async function waitUntilProcessDead(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${String(pid)} still alive after ${String(timeoutMs)} ms`);
}

afterEach(() => {
  for (const target of temporaryTargets.splice(0)) cleanupCliTarget(target);
  for (const packageRoot of temporaryAmbientPackages.splice(0)) {
    rmSync(packageRoot, { force: true, recursive: true });
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix = 'agent-eval-spawn-target-'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function installedCliFixture(
  root: string,
  options: {
    readonly bin?: string | Readonly<Record<string, unknown>>;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly entrypointBytes?: string;
    readonly name?: string;
  } = {},
): {
  readonly entrypoint: string;
  readonly packageJson: string;
  readonly packageRoot: string;
} {
  const packageRoot = join(root, 'node_modules', 'opensip-cli');
  const packageJson = join(packageRoot, 'package.json');
  const bin = options.bin ?? { opensip: './dist/index.js' };
  const binValue = typeof bin === 'string' ? bin : bin.opensip;
  if (typeof binValue !== 'string') throw new TypeError('fixture bin must name an entrypoint');
  const entrypoint = resolve(packageRoot, binValue);
  mkdirSync(dirname(entrypoint), { recursive: true });
  writeFileSync(
    packageJson,
    `${JSON.stringify({ bin, dependencies: options.dependencies, name: options.name ?? 'opensip-cli', version: '1.2.3' })}\n`,
  );
  writeFileSync(entrypoint, options.entrypointBytes ?? 'export default 1;\n');
  return { entrypoint, packageJson, packageRoot };
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
    // Bound is "terminates promptly under load", not a tight real-time SLO —
    // loaded Linux CI has occasionally exceeded a 2s wall (e.g. 2029ms).
    expect(Date.now() - started).toBeLessThan(10_000);
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

  it.skipIf(process.platform === 'win32')(
    'fails the run without leaking the root when descendant sampling is unavailable',
    async () => {
      const result = await spawnProcess(process.execPath, ['-e', 'process.exit(0)'], {
        processSnapshot: () => {
          throw new Error('process inventory unavailable');
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.error).toMatch(/descendant observation became unavailable/u);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'retains group cleanup after the root exits and kills a TERM-ignoring descendant',
    async () => {
      const root = temporaryDirectory('agent-eval-orphan-cleanup-');
      const pidPath = join(root, 'descendant.pid');
      const descendantSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const rootSource = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
        `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        'child.unref();',
      ].join('\n');

      const result = await spawnProcess(process.execPath, ['-e', rootSource], {
        cwd: root,
        timeoutMs: 5000,
      });
      const descendantPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);

      expect(result.exitCode).toBe(0);
      expect(result.error).toMatch(
        /surviving descendant|descendant observation became unavailable|did not terminate after bounded/u,
      );
      // Reaping after SIGKILL is asynchronous on loaded CI runners.
      await waitUntilProcessDead(descendantPid);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tracks and kills a TERM-ignoring descendant that creates a new process group',
    async () => {
      const root = temporaryDirectory('agent-eval-detached-cleanup-');
      const pidPath = join(root, 'descendant.pid');
      const descendantSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const rootSource = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
        `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        'child.unref();',
        'setTimeout(() => {}, 450);',
      ].join('\n');

      const result = await spawnProcess(process.execPath, ['-e', rootSource], {
        cwd: root,
        timeoutMs: 5000,
      });
      const descendantPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);

      expect(result.exitCode).toBe(0);
      expect(result.error).toMatch(
        /surviving descendant|descendant observation became unavailable|did not terminate after bounded/u,
      );
      await waitUntilProcessDead(descendantPid);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'force-settles when an unobserved new-session descendant keeps stdio open',
    async () => {
      const root = temporaryDirectory('agent-eval-force-settle-');
      const pidPath = join(root, 'descendant.pid');
      const descendantSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const rootSource = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        'setTimeout(() => {',
        `  const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
        `  writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        '  child.unref();',
        '}, 50);',
      ].join('\n');
      const startedAt = Date.now();
      let descendantPid: number | undefined;
      try {
        const result = await spawnProcess(process.execPath, ['-e', rootSource], {
          cwd: root,
          processSnapshot: () => [],
          timeoutMs: 5000,
        });
        descendantPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);

        expect(Date.now() - startedAt).toBeLessThan(5000);
        expect(result.exitCode).toBe(0);
        expect(result.error).toMatch(
          /descendant observation became unavailable|stdio did not settle|unobserved detached descendant/u,
        );
      } finally {
        if (descendantPid !== undefined) {
          try {
            process.kill(-descendantPid, 'SIGKILL');
          } catch {
            // The escaped fixture process may already have exited independently.
          }
        }
      }
    },
  );
});

describe('validateInstalledEntrypoint', () => {
  it('accepts the regular JS bin declared by an installed opensip-cli package', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    expect(validateInstalledEntrypoint(entrypoint)).toBe(entrypoint);
  });

  it('resolves a symlink alias to the package-declared regular-file realpath', () => {
    const root = temporaryDirectory();
    const { entrypoint: real } = installedCliFixture(root, {
      bin: { opensip: './dist/real.mjs' },
    });
    const link = join(root, 'link.mjs');
    symlinkSync(real, link);
    expect(validateInstalledEntrypoint(link)).toBe(real);
  });

  it('rejects an arbitrary standalone JS file outside an installed package', () => {
    const root = temporaryDirectory();
    const entrypoint = join(root, 'index.js');
    writeFileSync(entrypoint, 'export default 1;\n');

    expect(() => validateInstalledEntrypoint(entrypoint)).toThrow(/node_modules\/opensip-cli/u);
  });

  it('rejects a JS file in the package that is not the declared opensip bin', () => {
    const root = temporaryDirectory();
    const { packageRoot } = installedCliFixture(root);
    const unrelated = join(packageRoot, 'dist', 'other.js');
    writeFileSync(unrelated, 'export default 2;\n');

    expect(() => validateInstalledEntrypoint(unrelated)).toThrow(/not the bin declared/u);
  });

  it('accepts package.json string-bin semantics', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root, {
      bin: './dist/index.cjs',
    });
    expect(validateInstalledEntrypoint(entrypoint)).toBe(entrypoint);
  });

  it('rejects the same layout when package.json has the wrong package name', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root, { name: '@other/cli' });
    expect(() => validateInstalledEntrypoint(entrypoint)).toThrow(/exact package name/u);
  });

  it.each([
    [{ other: './dist/index.js' }, /bin\.opensip/u],
    [{ opensip: '../outside.js' }, /package-relative/u],
    [{ opensip: './dist/index.cmd' }, /\.js, \.mjs, or \.cjs/u],
    [{ opensip: '/absolute/index.js' }, /package-relative/u],
    [{ opensip: '.\\dist\\index.js' }, /package-relative/u],
  ])('rejects an invalid package bin declaration %#', (bin, expected) => {
    const root = temporaryDirectory();
    const packageRoot = join(root, 'node_modules', 'opensip-cli');
    const entrypoint = join(packageRoot, 'dist', 'index.js');
    mkdirSync(dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, 'export default 1;\n');
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({ bin, name: 'opensip-cli' })}\n`,
    );

    expect(() => validateInstalledEntrypoint(entrypoint)).toThrow(expected);
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

  it('rejects an installed entrypoint over the hard hashing bound', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    truncateSync(entrypoint, MAX_INSTALLED_ENTRYPOINT_BYTES + 1);

    expect(() => buildCliTarget(entrypoint)).toThrow(/exceeds.*byte limit/u);
  });

  it('rejects an oversized package manifest before parsing it', () => {
    const root = temporaryDirectory();
    const { entrypoint, packageJson } = installedCliFixture(root);
    truncateSync(packageJson, MAX_INSTALLED_PACKAGE_JSON_BYTES + 1);

    expect(() => buildCliTarget(entrypoint)).toThrow(/package\.json exceeds.*byte limit/u);
  });

  it('rejects malformed dependency maps instead of silently omitting the closure', () => {
    const root = temporaryDirectory();
    const { entrypoint, packageJson } = installedCliFixture(root);
    writeFileSync(
      packageJson,
      `${JSON.stringify({
        bin: { opensip: './dist/index.js' },
        dependencies: { malformed: 42 },
        name: 'opensip-cli',
      })}\n`,
    );

    expect(() => buildCliTarget(entrypoint)).toThrow(/dependencies.*string values/u);
  });

  it('rejects a declared dependency found only above the target installation root', () => {
    const root = temporaryDirectory();
    const projectRoot = join(root, 'project');
    const dependencyName = `ambient-declared-${basename(root)}`;
    const { entrypoint } = installedCliFixture(projectRoot, {
      dependencies: { [dependencyName]: '1.0.0' },
    });
    const ambientRoot = join(root, 'node_modules', dependencyName);
    mkdirSync(ambientRoot, { recursive: true });
    writeFileSync(
      join(ambientRoot, 'package.json'),
      `${JSON.stringify({ name: dependencyName, version: '1.0.0' })}\n`,
    );

    expect(() => buildCliTarget(entrypoint)).toThrow(
      /dependency.*could not be resolved for snapshotting/u,
    );
  });

  it('rejects a declared dependency whose installed-package realpath escapes the target root', () => {
    const root = temporaryDirectory();
    const projectRoot = join(root, 'project');
    const dependencyName = 'escaping-dependency';
    const { entrypoint } = installedCliFixture(projectRoot, {
      dependencies: { [dependencyName]: '1.0.0' },
    });
    const externalRoot = join(root, 'external-dependency');
    mkdirSync(externalRoot, { recursive: true });
    writeFileSync(
      join(externalRoot, 'package.json'),
      `${JSON.stringify({ name: dependencyName, version: '1.0.0' })}\n`,
    );
    symlinkSync(externalRoot, join(projectRoot, 'node_modules', dependencyName), 'dir');

    expect(() => buildCliTarget(entrypoint)).toThrow(/dependency.*escapes its installation root/u);
  });

  it('rejects a symlinked package manifest rather than following it', () => {
    const root = temporaryDirectory();
    const { entrypoint, packageJson, packageRoot } = installedCliFixture(root);
    const substitute = join(packageRoot, 'manifest-substitute.json');
    renameSync(packageJson, substitute);
    symlinkSync(substitute, packageJson);

    expect(() => buildCliTarget(entrypoint)).toThrow(/package\.json.*regular file/u);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO entrypoint without blocking', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    rmSync(entrypoint);
    execFileSync('mkfifo', [entrypoint]);

    expect(() => buildCliTarget(entrypoint)).toThrow(/entrypoint.*regular file/u);
  });
});

describe('buildCliTarget', () => {
  it('requires no-follow on POSIX but uses the read-only identity-check path on Windows', () => {
    expect(installedEntrypointOpenFlags('win32', { O_RDONLY: 0 })).toBe(0);
    expect(
      installedEntrypointOpenFlags('linux', {
        O_NONBLOCK: 2048,
        O_NOFOLLOW: 131_072,
        O_RDONLY: 0,
      }),
    ).toBe(133_120);
    expect(() => installedEntrypointOpenFlags('darwin', { O_RDONLY: 0 })).toThrow(
      /without following links/u,
    );
    expect(() =>
      installedEntrypointOpenFlags('linux', {
        O_NOFOLLOW: 131_072,
        O_RDONLY: 0,
      }),
    ).toThrow(/without blocking/u);
  });

  it('builds a workspace target without asserting the dist exists', () => {
    const target = buildCliTarget();
    expect(target.source).toBe('workspace');
    expect(target.command).toBe(process.execPath);
    expect(target.entrypoint.endsWith('index.js')).toBe(true);
  });

  it('builds an immutable installed target from a verified entrypoint', () => {
    const root = temporaryDirectory();
    const { entrypoint, packageJson, packageRoot } = installedCliFixture(root);
    const target = buildCliTarget(entrypoint);
    expect(target).toMatchObject({
      command: process.execPath,
      entrypoint,
      packageJsonPath: packageJson,
      packageRoot,
      source: 'installed',
    });
    expect(target.source === 'installed' && target.executionEntrypoint).not.toBe(entrypoint);
    expect(target.source === 'installed' && target.entrypointIdentity.sha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(Object.isFrozen(target)).toBe(true);
    expect(target.source === 'installed' && Object.isFrozen(target.entrypointIdentity)).toBe(true);
    expect(target.source === 'installed' && Object.isFrozen(target.packageJsonIdentity)).toBe(true);
    expect(target.source === 'installed' && Object.isFrozen(target.snapshotTreeMetadata)).toBe(
      true,
    );
    expect(
      target.source === 'installed' &&
        target.snapshotTreeMetadata.every(
          (node) =>
            Object.isFrozen(node) &&
            (node.entryNames === undefined || Object.isFrozen(node.entryNames)),
        ),
    ).toBe(true);
    expect(Object.isFrozen(target.executionPrelude)).toBe(true);
    expect(target.executionPrelude).toHaveLength(2);
    expect(target.executionPrelude[0]).toBe('--require');
  });
});

describe('assertTargetRealpathStable', () => {
  it('is a no-op for a workspace target', () => {
    expect(() => assertTargetRealpathStable(buildCliTarget())).not.toThrow();
  });

  it('passes when an installed entrypoint is unchanged', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    expect(() => assertTargetRealpathStable(buildCliTarget(entrypoint))).not.toThrow();
  });

  it('rejects an installed entrypoint that vanished mid-run', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    const target = buildCliTarget(entrypoint);
    rmSync(entrypoint);
    expect(() => assertTargetRealpathStable(target)).toThrow(/changed|unavailable/u);
  });

  it('rejects an installed entrypoint whose node is no longer a regular file mid-run', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    const target = buildCliTarget(entrypoint);
    // Replace the regular file with a directory at the same path.
    rmSync(entrypoint);
    mkdirSync(entrypoint);
    expect(() => assertTargetRealpathStable(target)).toThrow(/changed|unavailable/u);
  });

  it('rejects in-place content mutation at the same installed entrypoint path', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    const target = buildCliTarget(entrypoint);

    writeFileSync(entrypoint, 'export default 2;\n');

    expect(() => assertTargetRealpathStable(target)).toThrow(/changed/u);
  });

  it('rejects an atomic same-path replacement even when the bytes are identical', () => {
    const root = temporaryDirectory();
    const { entrypoint, packageRoot } = installedCliFixture(root);
    const replacement = join(packageRoot, 'replacement.js');
    const bytes = 'export default 1;\n';
    writeFileSync(entrypoint, bytes);
    writeFileSync(replacement, bytes);
    const target = buildCliTarget(entrypoint);

    renameSync(replacement, entrypoint);

    expect(() => assertTargetRealpathStable(target)).toThrow(/changed/u);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a POSIX same-path swap from the pinned file to a symlink',
    () => {
      const root = temporaryDirectory();
      const { entrypoint, packageRoot } = installedCliFixture(root);
      const substitute = join(packageRoot, 'substitute.js');
      writeFileSync(substitute, 'export default 1;\n');
      const target = buildCliTarget(entrypoint);

      rmSync(entrypoint);
      symlinkSync(substitute, entrypoint);

      expect(() => assertTargetRealpathStable(target)).toThrow(/changed|unavailable/u);
    },
  );

  it('rejects a package manifest changed after target construction', () => {
    const root = temporaryDirectory();
    const { entrypoint, packageJson } = installedCliFixture(root);
    const target = buildCliTarget(entrypoint);
    writeFileSync(
      packageJson,
      `${JSON.stringify({ bin: { opensip: './dist/index.js' }, name: 'opensip-cli', x: 1 })}\n`,
    );

    expect(() => assertTargetRealpathStable(target)).toThrow(/changed|unavailable/u);
  });

  it('rejects a file added to the private snapshot', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    const target = buildCliTarget(entrypoint);
    if (target.source !== 'installed') throw new TypeError('expected an installed target');
    chmodSync(target.snapshotRoot, 0o700);
    writeFileSync(join(target.snapshotRoot, 'added.js'), 'export default 1;\n');
    chmodSync(target.snapshotRoot, 0o500);

    expect(() => assertTargetRealpathStable(target)).toThrow(/private snapshot changed/u);
  });

  it('rejects a file removed from the private snapshot', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    const target = buildCliTarget(entrypoint);
    if (target.source !== 'installed') throw new TypeError('expected an installed target');
    const resolutionGuard = target.executionPrelude[1];
    if (resolutionGuard === undefined) throw new TypeError('expected a resolution guard');
    chmodSync(target.snapshotRoot, 0o700);
    rmSync(resolutionGuard);
    chmodSync(target.snapshotRoot, 0o500);

    expect(() => assertTargetRealpathStable(target)).toThrow(/private snapshot changed/u);
  });

  it('rejects a private snapshot file replaced by a directory', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    const target = buildCliTarget(entrypoint);
    if (target.source !== 'installed') throw new TypeError('expected an installed target');
    const resolutionGuard = target.executionPrelude[1];
    if (resolutionGuard === undefined) throw new TypeError('expected a resolution guard');
    chmodSync(target.snapshotRoot, 0o700);
    rmSync(resolutionGuard);
    mkdirSync(resolutionGuard);
    chmodSync(target.snapshotRoot, 0o500);

    expect(() => assertTargetRealpathStable(target)).toThrow(/private snapshot changed/u);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a private snapshot file replaced by an escaping symlink',
    () => {
      const root = temporaryDirectory();
      const { entrypoint } = installedCliFixture(root);
      const target = buildCliTarget(entrypoint);
      if (target.source !== 'installed') throw new TypeError('expected an installed target');
      const resolutionGuard = target.executionPrelude[1];
      if (resolutionGuard === undefined) throw new TypeError('expected a resolution guard');
      chmodSync(target.snapshotRoot, 0o700);
      rmSync(resolutionGuard);
      symlinkSync(entrypoint, resolutionGuard);
      chmodSync(target.snapshotRoot, 0o500);

      expect(() => assertTargetRealpathStable(target)).toThrow(/private snapshot changed/u);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a special node added to the private snapshot',
    () => {
      const root = temporaryDirectory();
      const { entrypoint } = installedCliFixture(root);
      const target = buildCliTarget(entrypoint);
      if (target.source !== 'installed') throw new TypeError('expected an installed target');
      const fifo = join(target.snapshotRoot, 'unexpected.fifo');
      chmodSync(target.snapshotRoot, 0o700);
      execFileSync('mkfifo', [fifo]);
      chmodSync(target.snapshotRoot, 0o500);

      expect(() => assertTargetRealpathStable(target)).toThrow(/private snapshot changed/u);
    },
  );

  it('rejects a private snapshot mutation at the final content boundary', () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root);
    const target = buildCliTarget(entrypoint);
    if (target.source !== 'installed') throw new TypeError('expected an installed target');
    chmodSync(target.executionEntrypoint, 0o600);
    writeFileSync(target.executionEntrypoint, 'export default 2;\n');

    expect(() => assertTargetFinalStable(target)).toThrow(/private snapshot changed/u);
  });
});

describe('spawnCli target', () => {
  it('launches exactly the installed target entrypoint, never the workspace dist', async () => {
    const root = temporaryDirectory();
    // A fake installed JS bin that echoes the entrypoint the harness actually ran.
    const { entrypoint } = installedCliFixture(root, {
      bin: { opensip: './dist/fake-opensip.cjs' },
      entrypointBytes:
        "const { argv } = require('node:process'); process.stdout.write(argv[1] ?? '');\n",
    });
    const target = buildCliTarget(entrypoint);

    const result = await spawnCli(['--version'], { cwd: root, target });
    expect(result.exitCode).toBe(0);
    // The child was launched with the installed entrypoint — not the workspace build.
    expect(result.stdout).toBe(target.source === 'installed' ? target.executionEntrypoint : '');
    expect(result.stdout).not.toBe(workspaceCliDistPath());
    expect(result.stdout).not.toContain('cli/dist/index.js');
  });

  it('rejects a source-path mutation introduced in the spawn race', async () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root, {
      bin: { opensip: './dist/fake-opensip.cjs' },
      entrypointBytes: "process.stdout.write('verified-bytes');\n",
    });
    const target = buildCliTarget(entrypoint);
    const spawnChild = ((command: string, args: readonly string[], options: object) => {
      writeFileSync(entrypoint, "process.stdout.write('mutated-bytes');\n");
      return nodeSpawn(command, [...args], options);
    }) as typeof nodeSpawn;

    try {
      await expect(spawnCli([], { cwd: root, spawnChild, target })).rejects.toThrow(
        /entrypoint (?:changed|became unavailable)/u,
      );
      expect(() => assertTargetRealpathStable(target)).toThrow(/changed/u);
    } finally {
      cleanupCliTarget(target);
    }
  });

  it('executes snapshotted relative imports after the installed package dependency changes', async () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root, {
      bin: { opensip: './dist/fake-opensip.cjs' },
      entrypointBytes: "process.stdout.write(require('./value.cjs'));\n",
    });
    const dependency = join(dirname(entrypoint), 'value.cjs');
    writeFileSync(dependency, "module.exports = 'verified-dependency';\n");
    const target = buildCliTarget(entrypoint);
    writeFileSync(dependency, "module.exports = 'mutated-dependency';\n");

    const result = await spawnCli([], { cwd: root, target });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('verified-dependency');
  });

  it('executes the snapshotted installed dependency closure after a bare dependency changes', async () => {
    const root = temporaryDirectory();
    const { entrypoint, packageRoot } = installedCliFixture(root, {
      bin: { opensip: './dist/fake-opensip.cjs' },
      dependencies: { 'runtime-value': '1.0.0' },
      entrypointBytes: "process.stdout.write(require('runtime-value'));\n",
    });
    const dependencyRoot = join(packageRoot, 'node_modules', 'runtime-value');
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(
      join(dependencyRoot, 'package.json'),
      `${JSON.stringify({ main: './index.cjs', name: 'runtime-value', version: '1.0.0' })}\n`,
    );
    const dependencyEntrypoint = join(dependencyRoot, 'index.cjs');
    writeFileSync(dependencyEntrypoint, "module.exports = 'verified-closure';\n");
    const target = buildCliTarget(entrypoint);
    writeFileSync(dependencyEntrypoint, "module.exports = 'mutated-closure';\n");

    const result = await spawnCli([], { cwd: root, target });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('verified-closure');
  });

  it('snapshots a nested package dependency hoisted to the original installation root', async () => {
    const root = temporaryDirectory();
    const projectRoot = join(root, 'project');
    const { entrypoint, packageRoot } = installedCliFixture(projectRoot, {
      bin: { opensip: './dist/fake-opensip.cjs' },
      dependencies: { 'nested-runtime': '1.0.0' },
      entrypointBytes: "process.stdout.write(require('nested-runtime'));\n",
    });
    const nestedRoot = join(packageRoot, 'node_modules', 'nested-runtime');
    mkdirSync(nestedRoot, { recursive: true });
    writeFileSync(
      join(nestedRoot, 'package.json'),
      `${JSON.stringify({
        dependencies: { 'hoisted-runtime': '1.0.0' },
        main: './index.cjs',
        name: 'nested-runtime',
        version: '1.0.0',
      })}\n`,
    );
    writeFileSync(join(nestedRoot, 'index.cjs'), "module.exports = require('hoisted-runtime');\n");
    const hoistedRoot = join(projectRoot, 'node_modules', 'hoisted-runtime');
    mkdirSync(hoistedRoot, { recursive: true });
    writeFileSync(
      join(hoistedRoot, 'package.json'),
      `${JSON.stringify({
        main: './index.cjs',
        name: 'hoisted-runtime',
        version: '1.0.0',
      })}\n`,
    );
    writeFileSync(join(hoistedRoot, 'index.cjs'), "module.exports = 'verified-hoist';\n");
    const target = buildCliTarget(entrypoint);

    const result = await spawnCli([], { cwd: root, target });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('verified-hoist');
  });

  it('rejects an execution that mutates its private snapshot', async () => {
    const root = temporaryDirectory();
    const { entrypoint } = installedCliFixture(root, {
      bin: { opensip: './dist/fake-opensip.cjs' },
      entrypointBytes: [
        "const fs = require('node:fs');",
        "process.stdout.write('original-snapshot');",
        'fs.chmodSync(__filename, 0o600);',
        'fs.writeFileSync(__filename, "process.stdout.write(\\"mutated-snapshot\\");\\n");',
      ].join('\n'),
    });
    const target = buildCliTarget(entrypoint);

    await expect(spawnCli([], { cwd: root, target })).rejects.toThrow(/private snapshot changed/u);
    expect(() => assertTargetRealpathStable(target)).toThrow(/private snapshot changed/u);
  });

  it('blocks undeclared imports that Node could resolve from ambient snapshot ancestors', async () => {
    const root = temporaryDirectory();
    const ambientName = `ambient-${basename(root)}`;
    const canary = 'mutable-ambient-module';
    const { entrypoint } = installedCliFixture(root, {
      bin: { opensip: './dist/fake-opensip.cjs' },
      entrypointBytes: `process.stdout.write(require(${JSON.stringify(ambientName)}));\n`,
    });
    const target = buildCliTarget(entrypoint);
    if (target.source !== 'installed') throw new TypeError('expected an installed target');
    const ambientRoot = join(dirname(target.snapshotRoot), 'node_modules', ambientName);
    temporaryAmbientPackages.push(ambientRoot);
    mkdirSync(ambientRoot, { recursive: true });
    writeFileSync(
      join(ambientRoot, 'package.json'),
      `${JSON.stringify({ main: './index.cjs', name: ambientName, version: '1.0.0' })}\n`,
    );
    writeFileSync(join(ambientRoot, 'index.cjs'), `module.exports = ${JSON.stringify(canary)};\n`);

    expect(createRequire(target.executionEntrypoint).resolve(ambientName)).toContain(ambientRoot);
    const result = await spawnCli([], { cwd: root, target });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain(canary);
    expect(result.stderr).toMatch(/module resolution escaped its immutable snapshot/u);
  });

  it('applies the ambient-resolution guard to ES module imports', async () => {
    const root = temporaryDirectory();
    const ambientName = `ambient-esm-${basename(root)}`;
    const canary = 'mutable-ambient-es-module';
    const { entrypoint } = installedCliFixture(root, {
      bin: { opensip: './dist/fake-opensip.mjs' },
      entrypointBytes: `import value from ${JSON.stringify(ambientName)}; process.stdout.write(value);\n`,
    });
    const target = buildCliTarget(entrypoint);
    if (target.source !== 'installed') throw new TypeError('expected an installed target');
    const ambientRoot = join(dirname(target.snapshotRoot), 'node_modules', ambientName);
    temporaryAmbientPackages.push(ambientRoot);
    mkdirSync(ambientRoot, { recursive: true });
    writeFileSync(
      join(ambientRoot, 'package.json'),
      `${JSON.stringify({ main: './index.mjs', name: ambientName, version: '1.0.0' })}\n`,
    );
    writeFileSync(join(ambientRoot, 'index.mjs'), `export default ${JSON.stringify(canary)};\n`);

    expect(createRequire(target.executionEntrypoint).resolve(ambientName)).toContain(ambientRoot);
    const result = await spawnCli([], { cwd: root, target });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain(canary);
    expect(result.stderr).toMatch(/module resolution escaped its immutable snapshot/u);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a same-path symlink replacement introduced in the spawn race',
    async () => {
      const root = temporaryDirectory();
      const { entrypoint } = installedCliFixture(root, {
        bin: { opensip: './dist/fake-opensip.cjs' },
        entrypointBytes: "process.stdout.write('verified-main');\n",
      });
      const replacement = join(dirname(entrypoint), 'replacement.cjs');
      writeFileSync(replacement, "process.stdout.write('replacement-main');\n");
      const target = buildCliTarget(entrypoint);
      const spawnChild = ((command: string, args: readonly string[], options: object) => {
        rmSync(entrypoint);
        symlinkSync(replacement, entrypoint);
        return nodeSpawn(command, [...args], options);
      }) as typeof nodeSpawn;

      await expect(spawnCli([], { cwd: root, spawnChild, target })).rejects.toThrow(
        /entrypoint (?:changed|became unavailable)/u,
      );
      expect(() => assertTargetRealpathStable(target)).toThrow(/changed|unavailable/u);
    },
  );
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
