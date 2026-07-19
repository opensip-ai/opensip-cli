import {
  existsSync as actualExistsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsProbe = vi.hoisted(() => ({
  absentEntryPath: undefined as string | undefined,
}));

type NodeFsModule = Record<string, unknown> & {
  readonly existsSync: typeof actualExistsSync;
};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<NodeFsModule>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]): boolean =>
      String(path) === fsProbe.absentEntryPath ? false : actual.existsSync(path),
  };
});

import { discoverPlugins, readProjectPluginsList } from '../discover.js';

import type { PluginLayout } from '../types.js';

const FIT_LAYOUT: PluginLayout = {
  domain: 'fit',
  userSubdirs: ['checks'],
};

let testDir: string;

beforeEach(() => {
  fsProbe.absentEntryPath = undefined;
  testDir = mkdtempSync(join(tmpdir(), 'opensip-discover-edges-'));
});

afterEach(() => {
  fsProbe.absentEntryPath = undefined;
  rmSync(testDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(testDir, 'opensip-cli.config.yml');
}

function nodeModulesDir(): string {
  return join(testDir, 'opensip-cli', '.runtime', 'plugins', 'fit', 'node_modules');
}

function writeConfig(contents: string): void {
  writeFileSync(configPath(), contents);
}

function writePackage(name: string, packageJson: string): string {
  const dir = join(nodeModulesDir(), ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), packageJson);
  return dir;
}

describe('plugin discovery edge cases', () => {
  it.each([
    ['a scalar YAML document', 'scalar\n'],
    ['a scalar plugins block', 'plugins: scalar\n'],
    ['a scalar domain declaration', 'plugins:\n  fit: scalar\n'],
  ])('treats %s as no declared plugin list', (_label, yaml) => {
    writeConfig(yaml);
    expect(readProjectPluginsList(testDir, 'fit')).toBeUndefined();
  });

  it('filters non-string declarations from an otherwise valid list', () => {
    writeConfig('plugins:\n  fit:\n    - "kept"\n    - 42\n    - null\n');
    expect(readProjectPluginsList(testDir, 'fit')).toEqual(['kept']);
  });

  it('skips a declared package whose directory is absent', () => {
    mkdirSync(nodeModulesDir(), { recursive: true });
    writeConfig('plugins:\n  fit:\n    - "missing"\n');

    expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
  });

  it('skips a declared package path that is a regular file rather than a directory', () => {
    mkdirSync(nodeModulesDir(), { recursive: true });
    writeFileSync(join(nodeModulesDir(), 'regular-file'), 'not a package');
    writeConfig('plugins:\n  fit:\n    - "regular-file"\n');

    expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
  });

  it('skips a declared package whose package.json is malformed', () => {
    writePackage('malformed', '{not-json');
    writeConfig('plugins:\n  fit:\n    - "malformed"\n');

    expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
  });

  it.runIf(platform() !== 'win32')(
    'rejects a package directory symlink that resolves outside node_modules',
    () => {
      const outside = join(testDir, 'outside-package');
      mkdirSync(outside);
      writeFileSync(
        join(outside, 'package.json'),
        JSON.stringify({ name: 'linked', main: './index.js' }),
      );
      writeFileSync(join(outside, 'index.js'), 'export {};\n');
      mkdirSync(nodeModulesDir(), { recursive: true });
      symlinkSync(outside, join(nodeModulesDir(), 'linked'));
      writeConfig('plugins:\n  fit:\n    - "linked"\n');

      expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
    },
  );

  it('skips an entry that disappears at the final defensive existence probe', () => {
    const dir = writePackage(
      'vanished-entry',
      JSON.stringify({ name: 'vanished-entry', main: './index.js' }),
    );
    const entry = join(dir, 'index.js');
    writeFileSync(entry, 'export {};\n');
    writeConfig('plugins:\n  fit:\n    - "vanished-entry"\n');
    expect(actualExistsSync(entry)).toBe(true);
    fsProbe.absentEntryPath = entry;

    expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
  });

  it('fails a loose-source walk closed when the declared subdirectory is not readable as one', () => {
    const checksPath = join(testDir, 'opensip-cli', 'fit', 'checks');
    mkdirSync(join(testDir, 'opensip-cli', 'fit'), { recursive: true });
    writeFileSync(checksPath, 'not a directory');

    expect(discoverPlugins(FIT_LAYOUT, testDir)).toEqual([]);
  });
});
