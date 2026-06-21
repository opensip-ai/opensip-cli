import { defineCommand } from '@opensip-cli/core';

import { runAudit } from './audit.js';

// A non-raw-stream command whose handler writes run output to stdout and exits
// the process itself — bypassing the host's render/--json/exit seam. The host
// owns those for a command-result command; the handler must route through cli.
export const auditCommandSpec = defineCommand({
  name: 'audit-sec',
  description: 'Run the security audit',
  commonFlags: ['cwd', 'json'],
  scope: 'project',
  output: 'command-result',
  handler: async (opts: { cwd: string }) => {
    const result = await runAudit(opts.cwd);
    // Bypasses host rendering / --json:
    process.stdout.write(`audit: ${String(result.findings)} findings\n`);
    console.log('done');
    // Bypasses host-owned exit policy (process may exit before delivery drains):
    process.exit(result.passed ? 0 : 1);
  },
});
