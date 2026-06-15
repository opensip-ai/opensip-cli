/**
 * Tests for plugin/config-edit covering the paths the higher-level
 * plugin-config.test.ts (which drives editPluginList through plugin.ts)
 * doesn't reach: the public `addToConfigPluginList` /
 * `removeFromConfigPluginList` wrappers, and the "config file exists but
 * parses to an empty document" branches.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addToConfigPluginList,
  removeFromConfigPluginList,
} from '../commands/plugin/config-edit.js';

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opensip-config-edit-'));
  configPath = join(dir, 'opensip-cli.config.yml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('addToConfigPluginList', () => {
  it('creates a minimal config when none exists', () => {
    expect(addToConfigPluginList(configPath, 'fit', '@org/pack')).toBe(true);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('plugins:');
    expect(text).toContain('@org/pack');
  });

  it('writes a fresh plugins map when the existing file is an empty document', () => {
    // A comment-only file parses to a null root, exercising the
    // `root === null` add branch.
    writeFileSync(configPath, '# just a comment, nothing else\n', 'utf8');
    expect(addToConfigPluginList(configPath, 'sim', '@org/scen')).toBe(true);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('sim');
    expect(text).toContain('@org/scen');
  });
});

describe('removeFromConfigPluginList', () => {
  it('returns false when the config does not exist', () => {
    expect(removeFromConfigPluginList(configPath, 'fit', '@org/pack')).toBe(false);
  });

  it('returns false on an empty document (nothing to remove)', () => {
    // Comment-only ⇒ null root ⇒ the remove branch returns false without
    // writing anything.
    writeFileSync(configPath, '# empty\n', 'utf8');
    expect(removeFromConfigPluginList(configPath, 'fit', '@org/pack')).toBe(false);
  });

  it('removes an existing entry and reports the change', () => {
    addToConfigPluginList(configPath, 'fit', '@org/a');
    addToConfigPluginList(configPath, 'fit', '@org/b');
    expect(removeFromConfigPluginList(configPath, 'fit', '@org/a')).toBe(true);
    const text = readFileSync(configPath, 'utf8');
    expect(text).not.toContain('@org/a');
    expect(text).toContain('@org/b');
  });

  it('returns false (no-op) when the entry to remove is absent from the list', () => {
    addToConfigPluginList(configPath, 'fit', '@org/keep');
    expect(removeFromConfigPluginList(configPath, 'fit', '@org/missing')).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toContain('@org/keep');
  });

  it('returns false when the domain list is absent or not a sequence', () => {
    // plugins.fit is a scalar, not a sequence → nothing to remove.
    writeFileSync(configPath, 'plugins:\n  fit: not-a-list\n', 'utf8');
    expect(removeFromConfigPluginList(configPath, 'fit', '@org/x')).toBe(false);
  });
});

describe('editPluginList — idempotency and malformed input', () => {
  it('add is idempotent — adding an existing entry returns false (no rewrite)', () => {
    expect(addToConfigPluginList(configPath, 'fit', '@org/dup')).toBe(true);
    expect(addToConfigPluginList(configPath, 'fit', '@org/dup')).toBe(false);
  });

  it('throws a clear error when the config YAML is malformed', () => {
    // Unterminated flow sequence → the YAML parser records a document error.
    writeFileSync(configPath, 'plugins:\n  fit: [unterminated\n', 'utf8');
    expect(() => addToConfigPluginList(configPath, 'fit', '@org/x')).toThrow(
      /Cannot edit plugins\.fit/,
    );
  });
});
