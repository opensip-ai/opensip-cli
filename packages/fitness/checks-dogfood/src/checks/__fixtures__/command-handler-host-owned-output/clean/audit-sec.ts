import { defineCommand } from '@opensip-cli/core';

import { runAudit } from './audit.js';

// A normal command: the host owns rendering, --json, and the exit code. The
// handler returns its result and routes the exit through the cli context.
export const auditCommandSpec = defineCommand({
  name: 'audit-sec',
  description: 'Run the security audit',
  commonFlags: ['cwd', 'json'],
  scope: 'project',
  output: 'command-result',
  handler: async (opts: { cwd: string }, cli: { setExitCode: (n: number) => void }) => {
    const result = await runAudit(opts.cwd);
    cli.setExitCode(result.passed ? 0 : 1);
    return result;
  },
});

// A raw-stream command DECLARES that it owns its own output surface — the
// escape hatch. Direct stdout here is expected and must NOT be flagged.
export const auditExportCommandSpec = defineCommand({
  name: 'audit-sec-export',
  description: 'Write the audit report to stdout',
  commonFlags: ['cwd'],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'file-export',
  handler: async (opts: { cwd: string }) => {
    const report = await runAudit(opts.cwd);
    process.stdout.write(JSON.stringify(report));
  },
});
