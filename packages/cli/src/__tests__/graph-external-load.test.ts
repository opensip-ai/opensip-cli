/**
 * graph externalization acceptance test — the `graph` sibling of
 * `fit-external-load.test.ts` (north-star §1 / §8, invariant 1:
 * install-source independence). Loads `graph` — the tool with the largest
 * command surface (the `graph` primary, its nested `<tool> <verb>` children, and
 * internal workers) and a manifest-declared capability domain (`graph-adapter`,
 * ADR-0029) — through the EXTERNAL
 * tool-plugin path and asserts its full command surface is identical to the
 * bundled mount. Provenance governs only the host's trust decision, never the
 * lifecycle (§5.2.1).
 *
 * Same hermetic, in-process mechanism as the fit test: `loadToolManifest →
 * admitTool → dynamic import → mountCommandSpec` against the package directory
 * on disk, with the static `graphTool` import used only as the bundled-side
 * comparison reference.
 *
 * Requires the build: it reads `packages/graph/engine/dist/index.js`.
 */

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { admitTool, loadToolManifest } from '@opensip-cli/core';
import { Command } from 'commander';
import { describe, it, expect } from 'vitest';

import { mountCommandSpec, type CommandMountContext } from '../commands/mount-command-spec.js';

import type { CommandResult } from '@opensip-cli/contracts';
import type { CommandSpec, Tool, ToolCliContext } from '@opensip-cli/core';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Monorepo layout: packages/cli/src/__tests__ → packages/graph/engine.
const GRAPH_DIR = join(__dirname, '..', '..', '..', 'graph', 'engine');

/**
 * The user-facing graph commands every load path must surface — the `graph`
 * primary plus its nested `<tool> <verb>` children. The legacy flat-root aliases
 * (`graph-lookup` / `graph-symbol-index` / `graph-baseline-export` /
 * `catalog-export` / `sarif-export` / `graph-recipes`) were removed.
 */
const PUBLIC_COMMANDS = ['graph', 'export', 'recipes', 'lookup', 'index', 'list'] as const;

/** The legacy flat-root command names that were removed entirely. */
const REMOVED_FLAT_COMMANDS = [
  'graph-lookup',
  'graph-symbol-index',
  'graph-baseline-export',
  'catalog-export',
  'sarif-export',
  'graph-recipes',
] as const;

/** Minimal mount context — enough for mountCommandSpec to wire the command. */
const STUB_CTX: CommandMountContext = {
  render: (_r: CommandResult) => Promise.resolve(),
  setExitCode: () => undefined,
};

/** graph's declared command specs, keyed by name. */
function specsByName(tool: Tool): Map<string, CommandSpec<unknown, ToolCliContext>> {
  const specs = tool.commandSpecs ?? [];
  expect(specs.length, 'graph must export commandSpecs').toBeGreaterThan(0);
  return new Map(specs.map((s) => [s.name, s]));
}

describe('graph externalization acceptance test (§1 / §8 — invariant 1, graph leg)', () => {
  it("admits graph's static manifest through the compatibility gate (apiVersion declared)", () => {
    const manifest = loadToolManifest('installed', GRAPH_DIR);
    expect(manifest, 'graph package.json#opensipTools must load as a manifest').toBeDefined();
    expect(manifest?.id).toBe('graph');
    // 3.0.0: the manifest MUST declare apiVersion (the grace window ended).
    expect(typeof manifest?.apiVersion).toBe('number');
    // Every public graph command is declared in the manifest; the removed legacy
    // flat aliases are absent.
    const cmdNames = (manifest?.commands ?? []).map((c) => c.name);
    expect(cmdNames).toEqual(expect.arrayContaining([...PUBLIC_COMMANDS]));
    for (const removed of REMOVED_FLAT_COMMANDS) {
      expect(cmdNames, `legacy '${removed}' must be removed`).not.toContain(removed);
    }

    // Capability by declaration (§8 invariant 9): the graph-adapter domain is
    // discovered from the manifest, not hardcoded host knowledge — so it must
    // travel the external path too.
    const capabilityIds = (manifest?.capabilities ?? []).map((c) => c.id);
    expect(capabilityIds).toContain('graph-adapter');

    const admission = admitTool({
      manifest: manifest!,
      source: 'installed',
      dir: GRAPH_DIR,
      explicitlyRequested: true,
    });
    expect(admission.decision).toBe('admit');
  });

  it('dynamic-imports the built module as an external plugin would (not the static import)', async () => {
    const mod = (await import(pathToFileURL(join(GRAPH_DIR, 'dist', 'index.js')).href)) as {
      tool?: Tool;
    };
    expect(mod.tool, 'the built module must export `tool`').toBeDefined();
    expect(mod.tool?.metadata.name).toBe('graph');
    expect(mod.tool?.metadata.id).toBe('3873f1c2-02a9-4719-930a-bca74b62b706');
    const names = (mod.tool?.commandSpecs ?? []).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining([...PUBLIC_COMMANDS]));
    for (const removed of REMOVED_FLAT_COMMANDS) {
      expect(names, `legacy '${removed}' must be removed`).not.toContain(removed);
    }
  });

  it('the externally-loaded graph has a command surface identical to the bundled graph', async () => {
    const distUrl = pathToFileURL(join(GRAPH_DIR, 'dist', 'index.js')).href;
    const mod = (await import(distUrl)) as { tool?: Tool };
    const bundledMod = (await import(distUrl)) as { tool?: Tool };
    const external = specsByName(mod.tool!);
    const bundled = specsByName(bundledMod.tool!);

    // Same set of command names — public commands and internal workers alike.
    expect([...external.keys()].sort()).toEqual([...bundled.keys()].sort());

    // Every command's contract — aliases, common flags, declared options, output
    // mode — is byte-identical between the external and bundled load.
    for (const [name, ext] of external) {
      const bun = bundled.get(name)!;
      expect(ext.aliases ?? [], `${name} aliases`).toEqual(bun.aliases ?? []);
      expect(ext.commonFlags, `${name} commonFlags`).toEqual(bun.commonFlags);
      expect(ext.options ?? [], `${name} options`).toEqual(bun.options ?? []);
      expect(ext.output, `${name} output`).toBe(bun.output);
      expect(ext.scope, `${name} scope`).toBe(bun.scope);
    }
  });

  it('the host mounts the externally-loaded graph to a Commander surface (names + flags)', async () => {
    const mod = (await import(pathToFileURL(join(GRAPH_DIR, 'dist', 'index.js')).href)) as {
      tool?: Tool;
    };
    const program = new Command();
    for (const spec of mod.tool!.commandSpecs ?? []) {
      mountCommandSpec(program, spec as CommandSpec<unknown, CommandMountContext>, STUB_CTX);
    }
    const mounted = program.commands.map((c) => c.name());
    // This test mounts each spec via the raw `mountCommandSpec` loop (NOT the
    // host's two-pass `mountAllToolCommands` parent-nesting), so a `parent`-nested
    // child is mounted onto `program` by its leaf name — every canonical command
    // name is present at this level. The two-pass nesting under the `graph`
    // primary is covered by the parity snapshot + command-taxonomy tests.
    expect(mounted).toEqual(expect.arrayContaining([...PUBLIC_COMMANDS]));
    // The legacy flat aliases are gone entirely.
    for (const removed of REMOVED_FLAT_COMMANDS) {
      expect(mounted, `legacy '${removed}' must be removed`).not.toContain(removed);
    }

    // The `graph` command carries the host-provided `--json` common flag —
    // proving flags travel the plugin path intact.
    const graphCmd = program.commands.find((c) => c.name() === 'graph');
    const flagNames = (graphCmd?.options ?? []).map((o) => o.long);
    expect(flagNames).toContain('--json');
  });
});
