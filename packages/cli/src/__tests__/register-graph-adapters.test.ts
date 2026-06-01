/**
 * Tests for register-graph-adapters — the CLI bootstrap hook that
 * discovers @opensip-tools/graph-* adapter packs and registers them
 * with the graph engine's lang-adapter registry.
 *
 * Lands in PR 1a of plan
 * docs/plans/architecture/2026-05-23-plan-graph-adapter-package-split.md.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverAndRegisterGraphAdapterPackages } from '../bootstrap/register-graph-adapters.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-cli-graph-adapter-bootstrap-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('discoverAndRegisterGraphAdapterPackages', () => {
  it('returns 0 when no @opensip-tools/graph-* packages are installed', async () => {
    const registered = await discoverAndRegisterGraphAdapterPackages({ projectDir: testDir });
    expect(registered).toBe(0);
  });

  it('logs cli.graph_adapter.load_failed and continues when a pack throws on import', async () => {
    // Build a fake @opensip-tools/graph-broken pack whose entry throws.
    const dir = join(testDir, 'node_modules', '@opensip-tools', 'graph-broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@opensip-tools/graph-broken', version: '0.0.0', main: './index.js' }),
    );
    writeFileSync(join(dir, 'index.js'), 'throw new Error("boot fail");');

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const registered = await discoverAndRegisterGraphAdapterPackages({ projectDir: testDir });
    expect(registered).toBe(0);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('loads and registers a pack that exports a valid adapter', async () => {
    const dir = join(testDir, 'node_modules', '@opensip-tools', 'graph-fixture');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@opensip-tools/graph-fixture', version: '0.0.0', type: 'module', main: './index.js' }),
    );
    writeFileSync(
      join(dir, 'index.js'),
      "export const adapter = { id: 'fixture-lang', extensions: ['.fx'] };",
    );

    const registered = await discoverAndRegisterGraphAdapterPackages({ projectDir: testDir });
    expect(registered).toBe(1);
  });

  it('skips a discovered pack whose package.json is unreadable (no metadata)', async () => {
    // Discovery only checks that package.json EXISTS (existsSync), so a
    // malformed package.json is still discovered, but
    // readGraphAdapterPackageMetadata returns undefined ⇒ the pack is
    // skipped before any import.
    const dir = join(testDir, 'node_modules', '@opensip-tools', 'graph-malformed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{ this is not valid json');

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const registered = await discoverAndRegisterGraphAdapterPackages({ projectDir: testDir });
    expect(registered).toBe(0);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('skips packs that lack a valid adapter export', async () => {
    const dir = join(testDir, 'node_modules', '@opensip-tools', 'graph-empty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@opensip-tools/graph-empty', version: '0.0.0', main: './index.js' }),
    );
    writeFileSync(join(dir, 'index.js'), 'export const notAdapter = {};');

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const registered = await discoverAndRegisterGraphAdapterPackages({ projectDir: testDir });
    expect(registered).toBe(0);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });
});
