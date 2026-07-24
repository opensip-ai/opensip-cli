import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isCapabilityFilesystemPathAllowed } from '../capability-worker/guards.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARDS_DIST = join(
  HERE,
  '..',
  '..',
  '..',
  'dist',
  'bootstrap',
  'capability-worker',
  'guards.js',
);

describe('capability worker filesystem guard', () => {
  it('checks every Node PathLike form against the allowed roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-outside-'));
    try {
      const roots = [root];
      const insidePath = join(root, 'allowed.txt');
      const outsidePath = join(outside, 'denied.txt');

      expect(isCapabilityFilesystemPathAllowed(insidePath, roots)).toBe(true);
      expect(isCapabilityFilesystemPathAllowed(pathToFileURL(insidePath), roots)).toBe(true);
      expect(isCapabilityFilesystemPathAllowed(Buffer.from(insidePath), roots)).toBe(true);

      expect(isCapabilityFilesystemPathAllowed(outsidePath, roots)).toBe(false);
      expect(isCapabilityFilesystemPathAllowed(pathToFileURL(outsidePath), roots)).toBe(false);
      expect(isCapabilityFilesystemPathAllowed(Buffer.from(outsidePath), roots)).toBe(false);

      expect(isCapabilityFilesystemPathAllowed(0, roots)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('denies a symlink escape from inside the allowed root (realpath containment)', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-outside-'));
    try {
      // A link INSIDE the root pointing OUTSIDE it — the old logical
      // resolve()+startsWith check admitted this; realpath containment must not.
      const link = join(root, 'escape');
      symlinkSync(outside, link, 'dir');
      expect(isCapabilityFilesystemPathAllowed(join(link, 'denied.txt'), [root])).toBe(false);
      expect(isCapabilityFilesystemPathAllowed(link, [root])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('allows creating a new file (missing leaf) inside the root, denies one outside', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-root-'));
    try {
      // Deepest existing ancestor is the root itself; the missing suffix
      // cannot contain a symlink.
      expect(isCapabilityFilesystemPathAllowed(join(root, 'new-file.txt'), [root])).toBe(true);
      expect(
        isCapabilityFilesystemPathAllowed(join(root, 'new-dir', 'deep', 'file.txt'), [root]),
      ).toBe(true);
      expect(
        isCapabilityFilesystemPathAllowed(join(tmpdir(), 'nonexistent-xyz', 'f.txt'), [root]),
      ).toBe(false);
      // A traversal that lexically escapes through a missing dir is denied.
      expect(
        isCapabilityFilesystemPathAllowed(join(root, 'missing', '..', '..', 'f.txt'), [root]),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks containment at the deepest existing ancestor when it is a subdirectory', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-root-'));
    try {
      mkdirSync(join(root, 'sub'));
      expect(isCapabilityFilesystemPathAllowed(join(root, 'sub', 'new', 'file.txt'), [root])).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('capability worker guards — advisory denial (child process)', () => {
  it('blocks undeclared unlink/rm/fetch with the advisory diagnostic (plan 09 Task 9.3.3)', () => {
    // The guard monkey-patches this PROCESS's module surface, so the
    // probe runs in a spawned child against the built dist. Posture under
    // test: the block is best-effort defense-in-depth for admitted code —
    // the thrown message says so explicitly (admission is the boundary).
    const dir = mkdtempSync(join(tmpdir(), 'opensip-guard-advisory-'));
    try {
      const script = join(dir, 'probe.mjs');
      writeFileSync(join(dir, 'victim.txt'), 'x');
      writeFileSync(
        script,
        `
import { installCapabilityWorkerGuards } from ${JSON.stringify(pathToFileURL(GUARDS_DIST).href)};
import { unlinkSync, rmSync } from 'node:fs';
const results = {};
installCapabilityWorkerGuards({
  cwd: process.argv[2],
  packageDir: process.argv[2],
  resourceDecision: { isolation: 'worker', allowedResources: [], denyUndeclared: true },
});
const attempt = (name, fn) => {
  try { fn(); results[name] = 'ALLOWED'; }
  catch (error) { results[name] = String(error && error.message); }
};
attempt('unlinkSync', () => unlinkSync(process.argv[2] + '/victim.txt'));
attempt('rmSync', () => rmSync(process.argv[2] + '/victim.txt'));
attempt('fetch', () => fetch('https://example.invalid/'));
process.stdout.write(JSON.stringify(results));
`,
      );
      const child = spawnSync(process.execPath, [script, dir], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(child.status, child.stderr).toBe(0);
      const results = JSON.parse(child.stdout) as Record<string, string>;
      // Network denial: global fetch is patched to the advisory throw.
      expect(results.fetch).toContain('advisory guard');
      expect(results.fetch).toContain('admission is the enforced boundary');
      // Filesystem: containment-scoped — in-root unlink/rm stay ALLOWED (the
      // pack owns its own root); the hardened denial is the out-of-root case
      // asserted below.
      expect(results.unlinkSync).toBe('ALLOWED');
      const outDir = mkdtempSync(join(tmpdir(), 'opensip-guard-out-'));
      try {
        writeFileSync(join(outDir, 'outside.txt'), 'x');
        const script2 = join(dir, 'probe-out.mjs');
        writeFileSync(
          script2,
          `
import { installCapabilityWorkerGuards } from ${JSON.stringify(pathToFileURL(GUARDS_DIST).href)};
import { unlinkSync } from 'node:fs';
installCapabilityWorkerGuards({
  cwd: process.argv[2],
  packageDir: process.argv[2],
  resourceDecision: { isolation: 'worker', allowedResources: [], denyUndeclared: true },
});
try {
  unlinkSync(process.argv[3]);
  process.stdout.write('ALLOWED');
} catch (error) {
  process.stdout.write(String(error && error.message));
}
`,
        );
        const child2 = spawnSync(process.execPath, [script2, dir, join(outDir, 'outside.txt')], {
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(child2.status, child2.stderr).toBe(0);
        expect(child2.stdout).toContain('advisory guard');
        expect(child2.stdout).toContain('admission is the enforced boundary');
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('validates the DESTINATION of two-path APIs (rename out of root denied)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-guard-rename-'));
    const outDir = mkdtempSync(join(tmpdir(), 'opensip-guard-rename-out-'));
    try {
      writeFileSync(join(dir, 'inside.txt'), 'x');
      const script = join(dir, 'probe-rename.mjs');
      writeFileSync(
        script,
        `
import { installCapabilityWorkerGuards } from ${JSON.stringify(pathToFileURL(GUARDS_DIST).href)};
import { renameSync, copyFileSync } from 'node:fs';
const results = {};
installCapabilityWorkerGuards({
  cwd: process.argv[2],
  packageDir: process.argv[2],
  resourceDecision: { isolation: 'worker', allowedResources: [], denyUndeclared: true },
});
const attempt = (name, fn) => {
  try { fn(); results[name] = 'ALLOWED'; }
  catch (error) { results[name] = String(error && error.message); }
};
attempt('renameOut', () => renameSync(process.argv[2] + '/inside.txt', process.argv[3] + '/escaped.txt'));
attempt('copyOut', () => copyFileSync(process.argv[2] + '/inside.txt', process.argv[3] + '/escaped-copy.txt'));
attempt('renameIn', () => renameSync(process.argv[2] + '/inside.txt', process.argv[2] + '/renamed.txt'));
process.stdout.write(JSON.stringify(results));
`,
      );
      const child = spawnSync(process.execPath, [script, dir, outDir], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(child.status, child.stderr).toBe(0);
      const results = JSON.parse(child.stdout) as Record<string, string>;
      // Destination outside the roots: denied even though the source is inside.
      expect(results.renameOut).toContain('advisory guard');
      expect(results.copyOut).toContain('advisory guard');
      // In-root to in-root stays allowed (the pack owns its root).
      expect(results.renameIn).toBe('ALLOWED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
