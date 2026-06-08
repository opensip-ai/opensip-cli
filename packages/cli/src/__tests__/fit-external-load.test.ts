/**
 * The 3.0.0 acceptance test (north-star §1 / §8): load `fit` — the strongest
 * tool (checks, recipes, config, sessions, a plugin ecosystem) — through the
 * EXTERNAL tool-plugin path and assert its full command surface is identical to
 * the bundled mount. This is the GA bar: a first-party tool behaves identically
 * whether it arrives bundled or installed, so the only thing provenance governs
 * is the host's trust decision, never the lifecycle (§5.2.1).
 *
 * Why this is the real proof now: 3.0.0's unified loader (Phase 0) already loads
 * BUNDLED `fit` by the same `loadToolManifest → admitTool → dynamic import →
 * mountCommandSpec` path an installed tool travels — install-source independence
 * is structural, not a special case. This test exercises that path on `fit` from
 * its package directory (as an installed plugin would), with NO reliance on the
 * static `fitnessTool` import for loading, and pins every one of fit's four
 * commands (fit, fit-list/list-checks, fit-recipes/list-recipes,
 * fit-baseline-export) to the bundled surface.
 *
 * The full packed-install variant (`pnpm pack` fit + its check-pack deps into a
 * sandbox and run the binary) is the CI-gated escalation of the SAME mechanism
 * the `e2e-discovery` install test already proves for a tool plugin; this
 * in-process proof is the reliable, hermetic core of the acceptance test.
 *
 * Requires the build: it reads `packages/fitness/engine/dist/index.js`.
 */

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { admitTool, loadToolManifest } from '@opensip-tools/core';
import { fitnessTool } from '@opensip-tools/fitness';
import { Command } from 'commander';
import { describe, it, expect } from 'vitest';

import { mountCommandSpec, type CommandMountContext } from '../commands/mount-command-spec.js';

import type { CommandResult } from '@opensip-tools/contracts';
import type { CommandSpec, Tool, ToolCliContext } from '@opensip-tools/core';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Monorepo layout: packages/cli/src/__tests__ → packages/fitness/engine.
const FIT_DIR = join(__dirname, '..', '..', '..', 'fitness', 'engine');

/** Minimal mount context — enough for mountCommandSpec to wire the command. */
const STUB_CTX: CommandMountContext = {
  render: (_r: CommandResult) => Promise.resolve(),
  setExitCode: () => undefined,
};

/** fit's four declared command specs, keyed by name. */
function specsByName(tool: Tool): Map<string, CommandSpec<unknown, ToolCliContext>> {
  const specs = tool.commandSpecs ?? [];
  expect(specs.length, 'fit must export commandSpecs').toBeGreaterThan(0);
  return new Map(specs.map((s) => [s.name, s]));
}

describe('fit externalization acceptance test (§1 / §8 — the GA bar)', () => {
  it("admits fit's static manifest through the compatibility gate (apiVersion declared)", () => {
    const manifest = loadToolManifest('installed', FIT_DIR);
    expect(manifest, 'fit package.json#opensipTools must load as a manifest').toBeDefined();
    expect(manifest?.id).toBe('fitness');
    // 3.0.0: the manifest MUST declare apiVersion (the grace window ended).
    expect(typeof manifest?.apiVersion).toBe('number');
    // All four fit commands are declared in the manifest.
    const cmdNames = (manifest?.commands ?? []).map((c) => c.name);
    expect(cmdNames).toEqual(
      expect.arrayContaining(['fit', 'fit-list', 'fit-recipes', 'fit-baseline-export']),
    );

    const admission = admitTool({
      manifest: manifest!,
      source: 'installed',
      dir: FIT_DIR,
      explicitlyRequested: true,
    });
    expect(admission.decision).toBe('admit');
  });

  it('dynamic-imports the built module as an external plugin would (not the static import)', async () => {
    const mod = (await import(pathToFileURL(join(FIT_DIR, 'dist', 'index.js')).href)) as { tool?: Tool };
    expect(mod.tool, 'the built module must export `tool`').toBeDefined();
    expect(mod.tool?.metadata.id).toBe('fitness');
    expect(mod.tool?.commandSpecs?.length).toBe(4);
  });

  it("the externally-loaded fit has a command surface identical to the bundled fit", async () => {
    const mod = (await import(pathToFileURL(join(FIT_DIR, 'dist', 'index.js')).href)) as { tool?: Tool };
    const external = specsByName(mod.tool!);
    const bundled = specsByName(fitnessTool);

    // Same set of command names (fit, fit-list, fit-recipes, fit-baseline-export).
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

  it('the host mounts the externally-loaded fit to a Commander surface (names + aliases + flags)', async () => {
    const mod = (await import(pathToFileURL(join(FIT_DIR, 'dist', 'index.js')).href)) as { tool?: Tool };
    const program = new Command();
    for (const spec of mod.tool!.commandSpecs ?? []) {
      mountCommandSpec(program, spec as CommandSpec<unknown, CommandMountContext>, STUB_CTX);
    }
    const mounted = program.commands.map((c) => c.name());
    expect(mounted).toEqual(expect.arrayContaining(['fit', 'fit-list', 'fit-recipes', 'fit-baseline-export']));

    // The `fit` command carries the host-provided `--json` common flag + its own
    // `--recipe` option — proving flags + options travel the plugin path intact.
    const fitCmd = program.commands.find((c) => c.name() === 'fit');
    const flagNames = (fitCmd?.options ?? []).map((o) => o.long);
    expect(flagNames).toContain('--json');
    expect(flagNames).toContain('--recipe');

    // The aliases survive the mount: `fit-list` answers to `list-checks`.
    const listCmd = program.commands.find((c) => c.name() === 'fit-list');
    expect(listCmd?.aliases()).toContain('list-checks');
  });
});
