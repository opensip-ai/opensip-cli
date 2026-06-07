import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
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
