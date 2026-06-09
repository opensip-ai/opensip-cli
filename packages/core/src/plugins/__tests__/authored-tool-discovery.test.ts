/**
 * Authored-Tool sidecar discovery (Phase 1): a source-agnostic walk over a
 * single authored `tools/` root that returns each `<root>/<name>/` dir carrying
 * an `opensip-tool.manifest.json` sidecar. Pure filesystem reads — no module
 * code is imported (the walk keys on the sidecar FILE's presence).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverAuthoredToolSidecars } from '../authored-tool-discovery.js';
import { PROJECT_LOCAL_MANIFEST_FILE } from '../manifest-loader.js';

let root: string;

/** Stage `<root>/<name>/opensip-tool.manifest.json` carrying a minimal manifest. */
function stageSidecarTool(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, PROJECT_LOCAL_MANIFEST_FILE),
    JSON.stringify({
      kind: 'tool',
      id: name,
      name: `${name} tool`,
      version: '1.0.0',
      commands: [{ name, description: `the ${name} command` }],
    }),
    'utf8',
  );
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-authored-discover-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discoverAuthoredToolSidecars', () => {
  it('returns an empty list when the root does not exist', () => {
    expect(discoverAuthoredToolSidecars(join(root, 'does-not-exist'))).toEqual([]);
  });

  it('returns an empty list for an empty root', () => {
    expect(discoverAuthoredToolSidecars(root)).toEqual([]);
  });

  it('returns each child dir carrying a sidecar, by dir + name', () => {
    const audit = stageSidecarTool('audit');
    const bench = stageSidecarTool('bench');
    const out = discoverAuthoredToolSidecars(root);
    const byName = new Map(out.map((c) => [c.name, c.dir]));
    expect(new Set(byName.keys())).toEqual(new Set(['audit', 'bench']));
    expect(byName.get('audit')).toBe(audit);
    expect(byName.get('bench')).toBe(bench);
  });

  it('excludes a child dir that has no sidecar', () => {
    stageSidecarTool('has-sidecar');
    mkdirSync(join(root, 'no-sidecar'), { recursive: true });
    writeFileSync(join(root, 'no-sidecar', 'README.md'), 'not a tool', 'utf8');
    expect(discoverAuthoredToolSidecars(root).map((c) => c.name)).toEqual(['has-sidecar']);
  });

  it('skips dot-prefixed entries (.runtime, .DS_Store, etc.)', () => {
    stageSidecarTool('real');
    // A dotdir that *does* carry a sidecar must still be skipped (dotfiles are
    // not authored tools — mirrors the marker walker's dotfile skip).
    const dotDir = join(root, '.hidden');
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, PROJECT_LOCAL_MANIFEST_FILE), '{}', 'utf8');
    expect(discoverAuthoredToolSidecars(root).map((c) => c.name)).toEqual(['real']);
  });

  it('reads no module code — a throwing entry next to a sidecar does not break discovery', () => {
    const dir = stageSidecarTool('with-throwing-entry');
    // Discovery keys on the sidecar file, never importing the runtime — so a
    // module that would throw on import must not affect the walk.
    writeFileSync(join(dir, 'index.js'), 'throw new Error("must never be imported by discovery");\n', 'utf8');
    const out = discoverAuthoredToolSidecars(root);
    expect(out.map((c) => c.name)).toEqual(['with-throwing-entry']);
    expect(out[0]?.dir).toBe(dir);
  });

  it('includes a dir even when its sidecar JSON is malformed (validity is the caller’s concern)', () => {
    const dir = join(root, 'malformed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PROJECT_LOCAL_MANIFEST_FILE), '{not-json', 'utf8');
    // The walk is location-only: presence of the sidecar IS the discovery
    // signal; admission (loadToolManifest/admitTool) decides validity later.
    expect(discoverAuthoredToolSidecars(root).map((c) => c.name)).toEqual(['malformed']);
  });

  it('ignores a plain file at the root (a file has no sidecar child)', () => {
    stageSidecarTool('a-tool');
    // A stray file directly under tools/ is not a tool dir — joining a sidecar
    // path under it does not exist, so it is excluded without crashing.
    writeFileSync(join(root, 'NOTES.txt'), 'loose file', 'utf8');
    expect(discoverAuthoredToolSidecars(root).map((c) => c.name)).toEqual(['a-tool']);
  });

  it('returns every sidecar dir when several coexist (directory listing is already unique)', () => {
    for (const n of ['t1', 't2', 't3']) stageSidecarTool(n);
    const names = discoverAuthoredToolSidecars(root).map((c) => c.name).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(['t1', 't2', 't3']);
  });
});
