/**
 * Sim externalization proof slice (north-star §8, release 2.13.0).
 *
 * Loads the REAL `sim` package through the components of the EXTERNAL tool-plugin
 * path — the static manifest loader (`loadToolManifest`), the compatibility
 * admission gate (`admitTool`), a dynamic `import()` of the built module, and the
 * host `mountCommandSpec`. It asserts the resulting command surface (name /
 * flags / output) is identical to the bundled mount. (3.0.0 note: the bundled
 * path now travels this SAME admit→dynamic-import path via `BUNDLED_TOOL_PACKAGES`
 * — see the `fit-external-load` acceptance test for the full packed-install proof.)
 *
 * This de-risks the 3.0.0 `fit` proof: it shows a first-party tool's manifest +
 * runtime export + CommandSpec all travel through the plugin loader intact, with no
 * loss of observable behaviour. The FULL "externalize and load instead of the
 * bundled build" (which needs sim un-bundled + published so the two don't collide
 * on id) is the 3.0.0 cutover.
 *
 * Requires the build: it reads `packages/simulation/engine/dist/index.js`.
 */

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { admitTool, loadToolManifest } from '@opensip-tools/core';
import { simulationTool } from '@opensip-tools/simulation';
import { Command } from 'commander';
import { describe, it, expect } from 'vitest';

import { mountCommandSpec, type CommandMountContext } from '../commands/mount-command-spec.js';

import type { CommandResult } from '@opensip-tools/contracts';
import type { CommandSpec, Tool, ToolCliContext } from '@opensip-tools/core';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Monorepo layout: packages/cli/src/__tests__ → packages/simulation/engine.
const SIM_DIR = join(__dirname, '..', '..', '..', 'simulation', 'engine');

/** Minimal mount context — enough for mountCommandSpec to wire the command. */
const STUB_CTX: CommandMountContext = {
  render: (_r: CommandResult) => Promise.resolve(),
  setExitCode: () => undefined,
};

function simSpec(tool: Tool): CommandSpec<unknown, ToolCliContext> {
  const spec = tool.commandSpecs?.[0];
  expect(spec, 'sim tool must export a CommandSpec').toBeDefined();
  return spec!;
}

describe('sim externalization proof slice (§8)', () => {
  it("admits sim's static manifest through the compatibility gate", () => {
    const manifest = loadToolManifest('installed', SIM_DIR);
    expect(manifest, 'sim package.json#opensipTools must load as a manifest').toBeDefined();
    expect(manifest?.id).toBe('simulation');
    expect(manifest?.apiVersion).toBeGreaterThanOrEqual(1);
    expect(manifest?.commands?.some((c) => c.name === 'sim')).toBe(true);

    const admission = admitTool({
      manifest: manifest!,
      source: 'installed',
      dir: SIM_DIR,
      explicitlyRequested: true,
    });
    expect(admission.decision).toBe('admit');
  });

  it('dynamic-imports the built module as an external plugin would (not the FIRST_PARTY import)', async () => {
    const mod = (await import(pathToFileURL(join(SIM_DIR, 'dist', 'index.js')).href)) as {
      tool?: Tool;
    };
    expect(mod.tool, 'the built module must export `tool`').toBeDefined();
    expect(mod.tool?.metadata.id).toBe('simulation');
    expect(mod.tool?.commandSpecs?.length).toBeGreaterThan(0);
  });

  it('mounts the externally-loaded CommandSpec to the SAME surface as the bundled mount', async () => {
    const mod = (await import(pathToFileURL(join(SIM_DIR, 'dist', 'index.js')).href)) as {
      tool?: Tool;
    };
    const external = simSpec(mod.tool!);
    const bundled = simSpec(simulationTool);

    // Identical command contract: name, common flags, declared options, output mode.
    expect(external.name).toBe('sim');
    expect(external.name).toBe(bundled.name);
    expect(external.commonFlags).toEqual(bundled.commonFlags);
    expect(external.options).toEqual(bundled.options);
    expect(external.output).toBe(bundled.output);

    // The host mount produces a real Commander command named `sim` with its flags.
    const program = new Command();
    mountCommandSpec(program, external as CommandSpec<unknown, CommandMountContext>, STUB_CTX);
    const cmd = program.commands.find((c) => c.name() === 'sim');
    expect(cmd, 'mountCommandSpec must mount a `sim` command').toBeDefined();
    const flagNames = cmd!.options.map((o) => o.long);
    expect(flagNames).toContain('--json'); // a common flag arrives via the host
    expect(flagNames).toContain('--recipe'); // sim's declared option
  });
});
