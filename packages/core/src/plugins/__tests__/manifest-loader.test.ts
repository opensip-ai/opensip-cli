import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../lib/logger.js';
import { PLUGIN_API_VERSION } from '../../tools/manifest.js';
import {
  admitTool,
  loadToolManifest,
  PROJECT_LOCAL_MANIFEST_FILE,
} from '../manifest-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const THROW_ON_IMPORT_DIR = join(HERE, '__fixtures__', 'throw-on-import');

let testDir: string;

function writeJson(path: string, json: object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(json));
}

function writePackageManifest(dir: string, json: object): void {
  writeJson(join(dir, 'package.json'), json);
}

function writeSidecar(dir: string, json: object): void {
  writeJson(join(dir, PROJECT_LOCAL_MANIFEST_FILE), json);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-manifest-loader-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('loadToolManifest', () => {
  it('reads a bundled/installed manifest from package.json#opensipTools', () => {
    writePackageManifest(testDir, {
      name: '@my-co/audit',
      version: '1.2.3',
      opensipTools: {
        kind: 'tool',
        id: 'audit',
        apiVersion: 1,
        commands: [
          { name: 'audit', description: 'Run an audit' },
          { name: 'audit-list', description: 'List audits', aliases: ['al'] },
        ],
      },
    });

    const manifest = loadToolManifest('bundled', testDir);
    expect(manifest).toBeDefined();
    expect(manifest).toMatchObject({
      kind: 'tool',
      id: 'audit',
      // name + version derived from package.json's OWN fields, not the block
      name: '@my-co/audit',
      version: '1.2.3',
      apiVersion: 1,
    });
    expect(manifest?.commands).toEqual([
      { name: 'audit', description: 'Run an audit' },
      { name: 'audit-list', description: 'List audits', aliases: ['al'] },
    ]);
  });

  it('installed source reads the same package.json block', () => {
    writePackageManifest(testDir, {
      name: 'installed-tool',
      version: '0.1.0',
      opensipTools: { kind: 'tool', id: 'installed', commands: [] },
    });
    const manifest = loadToolManifest('installed', testDir);
    expect(manifest?.id).toBe('installed');
    // No apiVersion declared → omitted (grace window handled by the gate).
    expect(manifest?.apiVersion).toBeUndefined();
  });

  it('reads a project-local manifest from the JSON sidecar', () => {
    writeSidecar(testDir, {
      kind: 'tool',
      id: 'local-tool',
      name: 'My Local Tool',
      version: '0.0.1',
      apiVersion: 1,
      commands: [{ name: 'go', description: 'Do the thing' }],
    });

    const manifest = loadToolManifest('project-local', testDir);
    expect(manifest).toMatchObject({
      kind: 'tool',
      id: 'local-tool',
      name: 'My Local Tool',
      version: '0.0.1',
      apiVersion: 1,
    });
  });

  it('returns undefined when the manifest file is missing', () => {
    expect(loadToolManifest('bundled', testDir)).toBeUndefined();
    expect(loadToolManifest('project-local', testDir)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'package.json'), '{ not valid json');
    expect(loadToolManifest('bundled', testDir)).toBeUndefined();
  });

  it('returns undefined when kind is not "tool"', () => {
    writePackageManifest(testDir, {
      name: 'x',
      version: '1.0.0',
      opensipTools: { kind: 'fit-pack', id: 'x', commands: [] },
    });
    expect(loadToolManifest('bundled', testDir)).toBeUndefined();
  });

  it('returns undefined when id is missing', () => {
    writePackageManifest(testDir, {
      name: 'x',
      version: '1.0.0',
      opensipTools: { kind: 'tool', commands: [] },
    });
    expect(loadToolManifest('bundled', testDir)).toBeUndefined();
  });

  it('returns undefined when name/version cannot be derived', () => {
    writePackageManifest(testDir, {
      // no name/version
      opensipTools: { kind: 'tool', id: 'x', commands: [] },
    });
    expect(loadToolManifest('bundled', testDir)).toBeUndefined();
  });

  it('returns undefined when commands is not an array', () => {
    writePackageManifest(testDir, {
      name: 'x',
      version: '1.0.0',
      opensipTools: { kind: 'tool', id: 'x', commands: 'nope' },
    });
    expect(loadToolManifest('bundled', testDir)).toBeUndefined();
  });

  it('returns undefined when a command entry is malformed', () => {
    writePackageManifest(testDir, {
      name: 'x',
      version: '1.0.0',
      opensipTools: {
        kind: 'tool',
        id: 'x',
        commands: [{ name: 'ok', description: 'fine' }, { name: 42 }],
      },
    });
    expect(loadToolManifest('bundled', testDir)).toBeUndefined();
  });

  it('returns undefined when apiVersion is not a number', () => {
    writePackageManifest(testDir, {
      name: 'x',
      version: '1.0.0',
      opensipTools: { kind: 'tool', id: 'x', apiVersion: 'one', commands: [] },
    });
    expect(loadToolManifest('bundled', testDir)).toBeUndefined();
  });

  it('READ-BEFORE-IMPORT: loads a throw-on-import tool WITHOUT importing its module', () => {
    // The fixture's main module throws synchronously on import. If
    // loadToolManifest imported it, this test would throw. Reaching the
    // assertions proves the loader read the static package.json only.
    const manifest = loadToolManifest('installed', THROW_ON_IMPORT_DIR);
    expect(manifest).toBeDefined();
    expect(manifest?.id).toBe('throw-on-import');
    expect(manifest?.commands).toEqual([
      { name: 'boom', description: 'A command from a tool that explodes on import' },
    ]);

    // And importing it for real DOES throw — proving the fixture is a real
    // landmine, so the load above genuinely avoided importing it.
    void expect(import(join(THROW_ON_IMPORT_DIR, 'index.mjs'))).rejects.toThrow(
      /read-before-import violated/,
    );
  });
});

function manifest(overrides: Partial<{ apiVersion: number | undefined; id: string }> = {}) {
  return {
    kind: 'tool' as const,
    id: overrides.id ?? 'audit',
    name: 'Audit',
    version: '1.2.3',
    apiVersion: 'apiVersion' in overrides ? overrides.apiVersion : PLUGIN_API_VERSION,
    commands: [{ name: 'audit', description: 'Run an audit' }],
  };
}

describe('admitTool', () => {
  it('admits a tool at the current epoch', () => {
    const result = admitTool({
      manifest: manifest({ apiVersion: PLUGIN_API_VERSION }),
      source: 'bundled',
      dir: '/tools/audit',
      packageName: '@my-co/audit',
      explicitlyRequested: false,
    });
    expect(result.decision).toBe('admit');
    expect(result.verdict.kind).toBe('compatible');
    expect(result.diagnostic).toBeUndefined();
    expect(result.provenance).toMatchObject({
      source: 'bundled',
      id: 'audit',
      version: '1.2.3',
      packageName: '@my-co/audit',
      resolvedPath: '/tools/audit',
    });
    expect(result.provenance.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips a not-explicitly-requested tool with a missing apiVersion (3.0.0 — grace window ended)', () => {
    const result = admitTool({
      manifest: manifest({ apiVersion: undefined }),
      source: 'project-local',
      dir: '/p',
      explicitlyRequested: false,
    });
    // 3.0.0: a missing apiVersion is incompatible; not explicitly requested → skip.
    expect(result.decision).toBe('skip');
    // No packageName supplied → omitted from provenance.
    expect(result.provenance.packageName).toBeUndefined();
  });

  it('skips a future-epoch tool that was NOT explicitly requested', () => {
    const result = admitTool({
      manifest: manifest({ apiVersion: 999 }),
      source: 'installed',
      dir: '/tools/future',
      explicitlyRequested: false,
    });
    expect(result.decision).toBe('skip');
    expect(result.verdict.kind).toBe('incompatible');
    expect(result.diagnostic).toBeTruthy();
    // Provenance still recorded for a skipped tool.
    expect(result.provenance.id).toBe('audit');
  });

  it('fails closed for a future-epoch tool that WAS explicitly requested', () => {
    const result = admitTool({
      manifest: manifest({ apiVersion: 999 }),
      source: 'installed',
      dir: '/tools/future',
      explicitlyRequested: true,
    });
    expect(result.decision).toBe('fail-closed');
    expect(result.verdict.kind).toBe('incompatible');
    expect(result.diagnostic).toBeTruthy();
  });

  it('produces a deterministic manifestHash, independent of key order', () => {
    const a = admitTool({
      manifest: {
        kind: 'tool',
        id: 'audit',
        name: 'Audit',
        version: '1.2.3',
        apiVersion: 1,
        commands: [{ name: 'audit', description: 'Run an audit' }],
      },
      source: 'bundled',
      dir: '/a',
      explicitlyRequested: false,
    });
    // Same identity, different declaration order + a different resolvedPath.
    const b = admitTool({
      manifest: {
        commands: [{ description: 'Run an audit', name: 'audit' }],
        apiVersion: 1,
        version: '1.2.3',
        name: 'Audit',
        id: 'audit',
        kind: 'tool',
      },
      source: 'bundled',
      dir: '/b-different-path',
      explicitlyRequested: false,
    });
    expect(a.provenance.manifestHash).toBe(b.provenance.manifestHash);
  });

  it('a different command set yields a different manifestHash', () => {
    const a = admitTool({
      manifest: manifest(),
      source: 'bundled',
      dir: '/a',
      explicitlyRequested: false,
    });
    const b = admitTool({
      manifest: {
        ...manifest(),
        commands: [{ name: 'audit', description: 'CHANGED' }],
      },
      source: 'bundled',
      dir: '/a',
      explicitlyRequested: false,
    });
    expect(a.provenance.manifestHash).not.toBe(b.provenance.manifestHash);
  });
});

describe('admitTool — structured admission diagnostics (Phase 4.2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits exactly one `plugin.manifest.loaded` evt on admit', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    admitTool({
      manifest: manifest({ apiVersion: PLUGIN_API_VERSION }),
      source: 'bundled',
      dir: '/tools/audit',
      packageName: '@my-co/audit',
      explicitlyRequested: false,
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      evt: 'plugin.manifest.loaded',
      id: 'audit',
      source: 'bundled',
      apiVersion: PLUGIN_API_VERSION,
      decision: 'admit',
    });
    expect((info.mock.calls[0]?.[0] as { manifestHash: string }).manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits one `plugin.incompatible.skipped` warn evt with the decision fields on skip', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    admitTool({
      manifest: manifest({ apiVersion: 999 }),
      source: 'installed',
      dir: '/tools/future',
      explicitlyRequested: false,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      evt: 'plugin.incompatible.skipped',
      id: 'audit',
      source: 'installed',
      apiVersion: 999,
      engine: PLUGIN_API_VERSION,
      decision: 'skip',
    });
    // Suggestion-bearing diagnostic: declared vs engine epoch.
    const evt = warn.mock.calls[0]?.[0] as { diagnostic: string };
    expect(evt.diagnostic).toContain('999');
    expect(evt.diagnostic).toContain(String(PLUGIN_API_VERSION));
  });

  it('emits one `plugin.incompatible.failed` error evt on fail-closed', () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    admitTool({
      manifest: manifest({ apiVersion: 999 }),
      source: 'installed',
      dir: '/tools/future',
      explicitlyRequested: true,
    });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      evt: 'plugin.incompatible.failed',
      id: 'audit',
      source: 'installed',
      apiVersion: 999,
      engine: PLUGIN_API_VERSION,
      decision: 'fail-closed',
    });
  });
});
