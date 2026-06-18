// @fitness-ignore-file one-outcome-shape -- this stdout JSON line is the PRIVATE parent↔child probe wire (runtime-probe.ts parses it), not the CLI's user-facing --json surface; renderOutcome/CommandOutcome govern user machine output, and the probe is never invoked as a CLI command.
/**
 * runtime-probe-entry — the child-process side of `tools validate`'s runtime
 * sections (ADR-0041).
 *
 * Spawned as `node <dist>/commands/tools/runtime-probe-entry.js <packageDir>`.
 * Runs the FULL admission pipeline (the runtime sections dynamic-import the
 * candidate package — UNTRUSTED code executes here, which is exactly why this
 * is a separate process: a crashing/hanging/env-mutating candidate cannot
 * corrupt the parent CLI, and the parent imposes a hard timeout. NOT a
 * security boundary — same user privileges) and prints a slim JSON report on
 * stdout. Exit 0 ⇔ report.ok.
 */

import { admitToolPackage } from '../../bootstrap/admit-tool-package.js';

import type { ProbeReport } from './runtime-probe.js';

const dir = process.argv[2];
if (dir === undefined || dir.length === 0) {
  process.stderr.write('runtime-probe-entry: missing package dir argument\n');
  process.exitCode = 2;
} else {
  const report = await admitToolPackage({
    dir,
    source: 'installed',
    explicitlyRequested: true,
  });
  const slim: ProbeReport = {
    ok: report.ok,
    sections: report.sections,
    toolConfigNamespace: report.tool?.config?.namespace ?? null,
    toolId: report.tool?.metadata.name ?? report.tool?.metadata.id ?? null,
  };
  process.stdout.write(`${JSON.stringify(slim)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
