/**
 * Authored-Tool end-to-end load (Phase 5.3): drive `discoverAndRegisterAuthoredTools`
 * — the real bootstrap walk — against fixture authored sidecar tools staged into a
 * temp project's `opensip-cli/tools/<name>/` and a temp `~/.opensip-cli/tools/<name>/`.
 *
 * Asserts the trust matrix end to end:
 *   - project tool, no allowlist  → throws PluginIncompatibleError (exit 5),
 *     and the tool module did NOT import (a throwing entry stays untouched).
 *   - project tool, allowlisted   → registered, provenance `project-local`.
 *   - global tool, no allowlist    → registered, provenance `user-global` + manifestHash.
 *
 * The fixture tool's runtime is plain JS exporting a valid `tool` (metadata.id +
 * commands + a non-empty commandSpecs handler) plus an `opensip-tool.manifest.json`
 * sidecar carrying `main` — the authored entry resolves from the sidecar (no
 * package.json).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mapToolErrorToExitCode, EXIT_CODES } from '@opensip-cli/contracts';
import { PluginIncompatibleError, ToolRegistry } from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverAndRegisterAuthoredTools } from '../bootstrap/register-tools.js';
import { PROJECT_TOOL_ALLOWLIST_ENV } from '../bootstrap/tool-trust.js';

import type { ToolPluginManifest, ToolProvenance } from '@opensip-cli/core';

const staged: string[] = [];

afterEach(() => {
  for (const d of staged.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Stage `<root>/<name>/` with a runtime `index.js` exporting a valid `tool` plus
 * an `opensip-tool.manifest.json` sidecar that points at it via `main`. When
 * `throwOnImport` is set, the runtime throws at import time — so a test can prove
 * the module was NEVER imported (the deny-by-default trust gate runs first).
 */
function stageAuthoredTool(
  root: string,
  name: string,
  opts: { throwOnImport?: boolean } = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const runtime = opts.throwOnImport
    ? 'throw new Error("authored tool module must not be imported before its trust decision");\n'
    : `export const tool = {
  metadata: { id: '00000000-0000-4000-8000-000000000000', name: ${JSON.stringify(name)}, version: '1.0.0', description: ${JSON.stringify(`${name} tool`)} },
  commands: [{ name: ${JSON.stringify(name)}, description: ${JSON.stringify(`the ${name} command`)} }],
  commandSpecs: [{
    name: ${JSON.stringify(name)},
    description: ${JSON.stringify(`the ${name} command`)},
    handler: () => ({ type: 'success', message: 'ok' }),
  }],
};
`;
  writeFileSync(join(dir, 'index.js'), runtime, 'utf8');
  writeFileSync(
    join(dir, 'opensip-tool.manifest.json'),
    JSON.stringify({
      kind: 'tool',
      id: name,
      name: `${name} tool`,
      version: '1.0.0',
      apiVersion: 1,
      main: './index.js',
      commands: [{ name, description: `the ${name} command` }],
    }),
    'utf8',
  );
  return dir;
}

/** Make a fresh temp dir, tracked for cleanup. */
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  staged.push(d);
  return d;
}

describe('authored-tool end-to-end load', () => {
  it('admits a global authored tool with NO allowlist, provenance user-global', async () => {
    const globalRoot = tmp('opensip-global-tools-');
    stageAuthoredTool(globalRoot, 'global-audit');
    const registry = new ToolRegistry();
    const provenance: ToolProvenance[] = [];
    const manifests: ToolPluginManifest[] = [];

    await discoverAndRegisterAuthoredTools(
      registry,
      { globalAuthoredDir: globalRoot, env: {} },
      new Set(),
      provenance,
      manifests,
    );

    expect(registry.get('global-audit')).toBeDefined();
    const prov = provenance.find((p) => p.id === 'global-audit');
    expect(prov?.source).toBe('user-global');
    expect(prov?.manifestHash.length).toBeGreaterThan(0);
    expect(manifests.some((m) => m.id === 'global-audit')).toBe(true);
  });

  it('fail-closes an un-allowlisted project tool (exit 5) WITHOUT importing it', async () => {
    const projectRoot = tmp('opensip-project-tools-');
    const globalRoot = tmp('opensip-global-empty-');
    // throwOnImport proves the module never ran: the trust gate throws first.
    stageAuthoredTool(projectRoot, 'risky-audit', { throwOnImport: true });
    const registry = new ToolRegistry();

    await expect(
      discoverAndRegisterAuthoredTools(
        registry,
        { projectAuthoredDir: projectRoot, globalAuthoredDir: globalRoot, env: {} },
        new Set(),
      ),
    ).rejects.toBeInstanceOf(PluginIncompatibleError);

    expect(registry.get('risky-audit')).toBeUndefined();
  });

  it('maps the un-allowlisted project tool throw to exit 5', async () => {
    const projectRoot = tmp('opensip-project-tools-');
    const globalRoot = tmp('opensip-global-empty-');
    stageAuthoredTool(projectRoot, 'risky-audit');
    const registry = new ToolRegistry();
    try {
      await discoverAndRegisterAuthoredTools(
        registry,
        { projectAuthoredDir: projectRoot, globalAuthoredDir: globalRoot, env: {} },
        new Set(),
      );
      expect.unreachable('expected a PluginIncompatibleError');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginIncompatibleError);
      expect(mapToolErrorToExitCode(error as PluginIncompatibleError)).toBe(
        EXIT_CODES.PLUGIN_INCOMPATIBLE,
      );
    }
  });

  it('admits an ALLOWLISTED project tool, provenance project-local', async () => {
    const projectRoot = tmp('opensip-project-tools-');
    const globalRoot = tmp('opensip-global-empty-');
    stageAuthoredTool(projectRoot, 'trusted-audit');
    const registry = new ToolRegistry();
    const provenance: ToolProvenance[] = [];

    await discoverAndRegisterAuthoredTools(
      registry,
      {
        projectAuthoredDir: projectRoot,
        globalAuthoredDir: globalRoot,
        env: { [PROJECT_TOOL_ALLOWLIST_ENV]: 'trusted-audit' },
      },
      new Set(),
      provenance,
    );

    expect(registry.get('trusted-audit')).toBeDefined();
    expect(provenance.find((p) => p.id === 'trusted-audit')?.source).toBe('project-local');
  });

  it('skips an authored tool whose id collides with a bundled (built-in) id', async () => {
    const globalRoot = tmp('opensip-global-tools-');
    stageAuthoredTool(globalRoot, 'fitness'); // same id as a bundled tool
    const registry = new ToolRegistry();
    const provenance: ToolProvenance[] = [];

    await discoverAndRegisterAuthoredTools(
      registry,
      { globalAuthoredDir: globalRoot, env: {} },
      new Set(['fitness']),
      provenance,
    );

    // builtInIds skip → not registered, no provenance recorded.
    expect(registry.get('fitness')).toBeUndefined();
    expect(provenance.some((p) => p.id === 'fitness')).toBe(false);
  });

  it('returns cleanly when neither authored root exists', async () => {
    const registry = new ToolRegistry();
    await expect(
      discoverAndRegisterAuthoredTools(
        registry,
        { globalAuthoredDir: join(tmpdir(), 'opensip-missing-global-root-xyz'), env: {} },
        new Set(),
      ),
    ).resolves.toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });
});
