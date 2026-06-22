/**
 * tool-command-worker-entry — unit coverage for the WORKER-side core of the
 * ADR-0054 dispatch plane (`runToolCommandWorker`), exercised IN-PROCESS (no
 * fork) so coverage instrumentation observes it. The forked end-to-end boundary
 * (full CLI bootstrap → discovery → handler) is proven separately in
 * `external-tool-dispatch.test.ts`.
 *
 * M4-E changed how the worker resolves the dispatched tool: it no longer imports
 * `spec.toolPackageDir` itself — the FULL CLI bootstrap (which runs first when the
 * supervisor forks the `__tool-command-worker` subcommand) discovers + registers
 * the tool into `currentScope().tools`, and `resolveTool` reads it from there.
 * So this in-process unit test stands in for that bootstrap: it imports the
 * fixture runtime, registers it into a fresh `RunScope`'s `ToolRegistry`, and runs
 * `runToolCommandWorker` inside that entered scope — exactly the state the real
 * bootstrap leaves before the worker handler runs.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  runWithScope,
  type Tool,
} from '@opensip-cli/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { runToolCommandWorker } from '../bootstrap/tool-command-worker-entry.js';

import type { ToolCommandWorkerSpec } from '../bootstrap/tool-command-dispatch-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'external-dispatch-tool');
const FIXTURE_ENTRY = join(FIXTURE_DIR, 'index.js');

// The fixture tool runtime, imported once and registered into each test's scope —
// standing in for the worker bootstrap's discover+register step.
let fixtureTool: Tool;

beforeAll(async () => {
  const mod = (await import(FIXTURE_ENTRY)) as { tool: Tool };
  fixtureTool = mod.tool;
});

function writeSpec(spec: ToolCommandWorkerSpec): string {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-worker-unit-'));
  const p = join(dir, 'spec.json');
  writeFileSync(p, JSON.stringify(spec), 'utf8');
  return p;
}

function specFor(overrides: Partial<ToolCommandWorkerSpec> = {}): ToolCommandWorkerSpec {
  return {
    toolId: 'external-dispatch-tool',
    toolPackageDir: FIXTURE_DIR,
    source: 'installed',
    commandName: 'ext-run',
    opts: { mode: 'ok' },
    positionals: [],
    ...overrides,
  };
}

/**
 * Run `runToolCommandWorker` inside a scope that has a tool registered — the state
 * the real worker bootstrap leaves. When `registerTool` is false, the scope is
 * empty (no tool registered) so `resolveTool` must fail `runtime-load-failed`,
 * mirroring a discovery/trust miss in the worker. `tool` overrides the registered
 * runtime (default: the fixture) so the config deep-pass edge branches can be
 * exercised with custom `extensionPoints.config` shapes.
 */
function runInScope(
  specPath: string,
  { registerTool = true, tool = fixtureTool }: { registerTool?: boolean; tool?: Tool } = {},
): ReturnType<typeof runToolCommandWorker> {
  const tools = new ToolRegistry();
  if (registerTool) tools.register(tool);
  const scope = new RunScope({ tools, languages: new LanguageRegistry(), runId: 'unit-run' });
  return runWithScope(scope, () => runToolCommandWorker(specPath));
}

/**
 * A minimal tool variant matching the fixture's id/command but with a customized
 * `config` extension point — for the deep-config-pass edge branches. The
 * command handler is a no-op envelope emitter (the config pass runs BEFORE it).
 */
function toolWithConfig(config: unknown): Tool {
  return {
    metadata: { ...fixtureTool.metadata },
    commandSpecs: fixtureTool.commandSpecs,
    ...(config === undefined ? {} : { extensionPoints: { config } }),
  } as Tool;
}

describe('runToolCommandWorker', () => {
  it('runs the handler and returns its recorded final-result (FRR seams)', async () => {
    const msg = await runInScope(writeSpec(specFor({ opts: { mode: 'ok', echo: 'x' } })));
    expect(msg.kind).toBe('result');
    if (msg.kind !== 'result') throw new Error('expected result');
    expect(msg.value.output).toBe('signal-envelope');
    const env = msg.value.envelope as { tool: string; signals: { echoedOpt: string }[] };
    expect(env.tool).toBe('external-dispatch-tool');
    expect(env.signals[0]?.echoedOpt).toBe('x');
    expect(msg.value.exitCode).toBe(0);
  });

  it('returns a bad-spec error for an unreadable spec file', async () => {
    const msg = await runInScope(join(tmpdir(), 'does-not-exist-12345.json'));
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('bad-spec');
  });

  it('returns runtime-load-failed when the tool is not registered in the worker scope', async () => {
    // No tool registered → resolveTool cannot find it (a discovery/trust miss in
    // the real worker bootstrap surfaces the same structured failure).
    const msg = await runInScope(writeSpec(specFor()), { registerTool: false });
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('runtime-load-failed');
  });

  it('returns command-not-found for an unknown command name', async () => {
    const msg = await runInScope(writeSpec(specFor({ commandName: 'nope' })));
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('command-not-found');
  });

  it('returns tool-handler-throw when the handler throws', async () => {
    const msg = await runInScope(writeSpec(specFor({ opts: { mode: 'throw' } })));
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('tool-handler-throw');
    expect(msg.message).toContain('external handler boom');
    expect(msg.stack).toBeTypeOf('string');
  });

  it('fails loud (unsupported-seam) when the handler calls a host-only live-view seam', async () => {
    const msg = await runInScope(writeSpec(specFor({ opts: { mode: 'live-seam' } })));
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('unsupported-seam');
    expect(msg.message).toContain("seam 'registerLiveView'");
  });

  it('config deep pass: a config block the tool schema rejects returns config-invalid', async () => {
    const msg = await runInScope(writeSpec(specFor({ config: { deep: 'bad' } })));
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('config-invalid');
    expect(msg.message).toContain('extdispatch.deep');
  });

  it('config deep pass: a valid config block lets the handler run (result)', async () => {
    const msg = await runInScope(writeSpec(specFor({ config: { deep: 'ok' } })));
    expect(msg.kind).toBe('result');
  });

  it('config deep pass: a tool with NO config declaration skips the deep pass (defers to coarse)', async () => {
    // The runtime declares no `extensionPoints.config` → the deep pass returns
    // undefined and the handler runs, even with a config block present.
    const msg = await runInScope(writeSpec(specFor({ config: { whatever: 1 } })), {
      tool: toolWithConfig(undefined),
    });
    expect(msg.kind).toBe('result');
  });

  it('config deep pass: a schema rejection with NO issue path falls back to the namespace name', async () => {
    // The schema rejects with an empty-path issue → the summary uses the
    // namespace name (the `issue.path` empty branch).
    const schema = {
      safeParse: () => ({
        success: false,
        error: { issues: [{ message: 'whole block invalid' }] },
      }),
    };
    const msg = await runInScope(writeSpec(specFor({ config: { x: 1 } })), {
      tool: toolWithConfig({ namespace: 'nons', schema }),
    });
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('config-invalid');
    expect(msg.message).toContain('nons.nons: whole block invalid');
  });

  it('config deep pass: a schema rejection with NO issues falls back to a generic message', async () => {
    // safeParse fails but carries no `issues` array → the generic fallback message.
    const schema = { safeParse: () => ({ success: false, error: {} }) };
    const msg = await runInScope(writeSpec(specFor({ config: { x: 1 } })), {
      tool: toolWithConfig({ namespace: 'nons', schema }),
    });
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('config-invalid');
    expect(msg.message).toContain('config did not satisfy the tool schema');
  });

  it('config deep pass: a config declaration whose schema is NOT safeParse-able is skipped', async () => {
    // `extensionPoints.config.schema` is not a Zod-ish object (no safeParse) → the
    // structural guard short-circuits and the handler runs.
    const msg = await runInScope(writeSpec(specFor({ config: { x: 1 } })), {
      tool: toolWithConfig({ namespace: 'nons', schema: { not: 'parseable' } }),
    });
    expect(msg.kind).toBe('result');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-0054 M4-F: hook mode + worker-side initialize.
  // ─────────────────────────────────────────────────────────────────────────

  it('M4-F hook mode: runs collectReportData and returns its contribution as hookResult', async () => {
    const msg = await runInScope(
      writeSpec(specFor({ commandName: undefined, hook: 'collectReportData' })),
    );
    expect(msg.kind).toBe('result');
    if (msg.kind !== 'result') throw new Error('expected result');
    const r = msg.value.hookResult as { extDispatchReport?: { ran: boolean } };
    expect(r.extDispatchReport?.ran).toBe(true);
  });

  it('M4-F hook mode: runs sessionReplay against the stored row and returns the replay as hookResult', async () => {
    const stored = { id: 'sess-42', tool: 'external-dispatch-tool', score: 7, passed: true };
    const msg = await runInScope(
      writeSpec(specFor({ commandName: undefined, hook: 'sessionReplay', hookArg: stored })),
    );
    expect(msg.kind).toBe('result');
    if (msg.kind !== 'result') throw new Error('expected result');
    const r = msg.value.hookResult as { fidelity: string; envelope: { runId: string } };
    expect(r.fidelity).toBe('projection');
    expect(r.envelope.runId).toBe('sess-42');
  });

  it('M4-F: a spec naming neither a command nor a hook is a bad-spec error', async () => {
    const msg = await runInScope(writeSpec(specFor({ commandName: undefined })));
    expect(msg.kind).toBe('error');
    if (msg.kind !== 'error') throw new Error('expected error');
    expect(msg.failureClass).toBe('bad-spec');
  });

  it('M4-F: the dispatched tool initialize runs worker-side before the handler (init-check echoes the sentinel)', async () => {
    const msg = await runInScope(writeSpec(specFor({ opts: { mode: 'init-check' } })));
    expect(msg.kind).toBe('result');
    if (msg.kind !== 'result') throw new Error('expected result');
    const env = msg.value.envelope as { signals: { initialized?: boolean }[] };
    // initialize ran (worker-side) before this handler, setting the sentinel.
    expect(env.signals[0]?.initialized).toBe(true);
  });
});
