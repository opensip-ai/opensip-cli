import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addTrustedToolToConfig } from '../trust-config.js';

let root: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-trust-config-'));
  configPath = join(root, 'opensip-cli.config.yml');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('addTrustedToolToConfig', () => {
  it('creates a config file when none exists', () => {
    expect(addTrustedToolToConfig(configPath, 'demo-tool')).toBe(true);

    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toContain('"demo-tool"');
  });

  it('initializes an empty document and appends new trusted tools idempotently', () => {
    writeFileSync(configPath, '', 'utf8');
    expect(addTrustedToolToConfig(configPath, 'demo-tool')).toBe(true);
    expect(addTrustedToolToConfig(configPath, 'demo-tool')).toBe(false);
    expect(addTrustedToolToConfig(configPath, 'other-tool')).toBe(true);

    const content = readFileSync(configPath, 'utf8');
    expect(content.match(/demo-tool/g)).toHaveLength(1);
    expect(content).toContain('other-tool');
  });

  it('adds missing tools and trusted nodes to an existing map', () => {
    writeFileSync(configPath, 'schemaVersion: 1\n', 'utf8');

    expect(addTrustedToolToConfig(configPath, 'demo-tool')).toBe(true);

    expect(readFileSync(configPath, 'utf8')).toContain('trusted:');
  });

  it('rejects malformed YAML, non-map roots, and incompatible tools shapes', () => {
    writeFileSync(configPath, 'tools: [unterminated\n', 'utf8');
    expect(() => addTrustedToolToConfig(configPath, 'demo-tool')).toThrow(/syntax error/i);

    writeFileSync(configPath, '- one\n- two\n', 'utf8');
    expect(() => addTrustedToolToConfig(configPath, 'demo-tool')).toThrow(/top-level node/);

    writeFileSync(configPath, 'tools: true\n', 'utf8');
    expect(() => addTrustedToolToConfig(configPath, 'demo-tool')).toThrow(/tools must be/);

    writeFileSync(configPath, 'tools:\n  trusted: true\n', 'utf8');
    expect(() => addTrustedToolToConfig(configPath, 'demo-tool')).toThrow(/tools.trusted/);
  });

  it('refuses to edit oversized config files', () => {
    writeFileSync(configPath, `# ${'x'.repeat(1_000_001)}\n`, 'utf8');

    expect(() => addTrustedToolToConfig(configPath, 'demo-tool')).toThrow(/larger than/);
  });
});
