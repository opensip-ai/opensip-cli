/**
 * Tests for the plugin-config YAML mutation paths.
 *
 * Phase 8 (F9) replaces the regex-driven line edits with the `yaml`
 * Document API. These tests pin the round-trip behaviour.
 *
 * The internal `editPluginList` is exposed through a `__test` export
 * so we can exercise the round-trip independently of `npm install`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __test as pluginInternals } from '../commands/plugin.js';

const { editPluginList } = pluginInternals;

let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'plugin-yaml-test-'));
  configPath = join(tempDir, 'opensip-tools.config.yml');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('editPluginList — add', () => {
  it('appends a new entry to an existing list and preserves comments + ordering', () => {
    writeFileSync(
      configPath,
      [
        '# project config',
        'targets:',
        '  ts:',
        '    languages: [typescript]',
        '',
        '# plugin block',
        'plugins:',
        '  fit:',
        '    - "@org/existing"',
        '  sim:',
        '    - "@org/scenarios"',
        '',
      ].join('\n'),
      'utf8',
    );

    const changed = editPluginList(configPath, 'fit', '@org/new', 'add');
    expect(changed).toBe(true);

    const after = readFileSync(configPath, 'utf8');
    expect(after).toContain('# project config');
    expect(after).toContain('# plugin block');
    expect(after).toContain('@org/existing');
    expect(after).toContain('@org/new');
    expect(after).toContain('@org/scenarios');
    // Targets block was preserved intact
    // Flow-style sequences may be re-spaced by yaml's serializer
    // (`[typescript]` → `[ typescript ]`); check for the value, not
    // the surrounding whitespace.
    expect(after).toContain('typescript');
  });

  it('is idempotent — re-adding the same name returns false and does not duplicate', () => {
    writeFileSync(configPath, 'plugins:\n  fit:\n    - "@org/foo"\n', 'utf8');
    expect(editPluginList(configPath, 'fit', '@org/foo', 'add')).toBe(false);
    const after = readFileSync(configPath, 'utf8');
    const matches = after.split('\n').filter((l) => l.includes('@org/foo'));
    expect(matches.length).toBe(1);
  });

  it('creates plugins.<domain> when the domain key is missing', () => {
    writeFileSync(configPath, 'plugins:\n  fit:\n    - "@org/foo"\n', 'utf8');
    expect(editPluginList(configPath, 'sim', '@org/scen', 'add')).toBe(true);
    const after = readFileSync(configPath, 'utf8');
    expect(after).toContain('@org/foo');
    expect(after).toContain('@org/scen');
  });

  it('creates the entire plugins block when absent', () => {
    writeFileSync(configPath, 'targets:\n  ts:\n    languages: [typescript]\n', 'utf8');
    expect(editPluginList(configPath, 'fit', '@org/foo', 'add')).toBe(true);
    const after = readFileSync(configPath, 'utf8');
    expect(after).toContain('plugins');
    expect(after).toContain('@org/foo');
    // Flow-style sequences may be re-spaced by yaml's serializer
    // (`[typescript]` → `[ typescript ]`); check for the value, not
    // the surrounding whitespace.
    expect(after).toContain('typescript');
  });

  it('writes a minimal config when the file does not exist', () => {
    expect(editPluginList(configPath, 'fit', '@org/new', 'add')).toBe(true);
    const after = readFileSync(configPath, 'utf8');
    expect(after).toContain('plugins:');
    expect(after).toContain('fit:');
    expect(after).toContain('@org/new');
  });
});

describe('editPluginList — remove', () => {
  it('removes the named entry and preserves the surrounding shape', () => {
    writeFileSync(
      configPath,
      [
        '# kept',
        'plugins:',
        '  fit:',
        '    - "@org/keep"',
        '    - "@org/drop"',
        '    - "@org/also-keep"',
        '',
      ].join('\n'),
      'utf8',
    );

    expect(editPluginList(configPath, 'fit', '@org/drop', 'remove')).toBe(true);
    const after = readFileSync(configPath, 'utf8');
    expect(after).toContain('@org/keep');
    expect(after).toContain('@org/also-keep');
    expect(after).not.toContain('@org/drop');
    expect(after).toContain('# kept');
  });

  it('returns false when the file is absent', () => {
    expect(editPluginList(configPath, 'fit', '@org/foo', 'remove')).toBe(false);
  });

  it('returns false when the named entry is not present', () => {
    writeFileSync(configPath, 'plugins:\n  fit:\n    - "@org/foo"\n', 'utf8');
    expect(editPluginList(configPath, 'fit', '@org/missing', 'remove')).toBe(false);
  });
});

describe('editPluginList — failure modes', () => {
  it('throws a clear error on a malformed YAML document', () => {
    // Unbalanced flow sequence — yaml's parseDocument surfaces the
    // error in `doc.errors` rather than throwing.
    writeFileSync(configPath, 'plugins: [unclosed\n', 'utf8');
    expect(() => editPluginList(configPath, 'fit', '@org/foo', 'add')).toThrow(
      /Cannot edit plugins\.fit/,
    );
  });

  it('refuses to edit a non-mapping top-level document', () => {
    writeFileSync(configPath, '- one\n- two\n', 'utf8');
    expect(() => editPluginList(configPath, 'fit', '@org/foo', 'add')).toThrow(/not a mapping/);
  });
});
