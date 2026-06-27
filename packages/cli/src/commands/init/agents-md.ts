/**
 * Write-if-absent AGENTS.md agent playbook (ADR-0085, spec §5.7).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ToolScaffold } from '../shared.js';

function hasFitDomain(toolScaffolds: readonly ToolScaffold[]): boolean {
  return toolScaffolds.some((t) => t.layout.domain === 'fit');
}

function buildPlaybook(toolScaffolds: readonly ToolScaffold[]): string {
  const lines = [
    '# OpenSIP Agent Playbook',
    '',
    'Machine-first workflow for coding agents using OpenSIP CLI.',
    '',
    '## Discover',
    '',
    '```bash',
    'opensip agent-catalog --json',
    '```',
    '',
    '## Read latest results first',
    '',
    'When the user references existing findings, inspect the latest stored result before re-running:',
    '',
    '```bash',
    'opensip sessions show latest --tool fit --json --filter errors-only --filter top:20',
    '```',
    '',
    '## Edit loop',
    '',
  ];

  if (hasFitDomain(toolScaffolds)) {
    lines.push(
      '```bash',
      'opensip fit --recipe agent-fast --json --filter errors-only',
      'opensip graph impact --changed --json --top 20',
      'opensip fit --changed --include-impacted --json',
      '```',
    );
  } else {
    lines.push('```bash', 'opensip graph impact --changed --json --top 20', '```');
  }

  lines.push(
    '',
    '## Final handoff',
    '',
    '```bash',
    hasFitDomain(toolScaffolds)
      ? 'opensip fit --recipe agent-final --gate-compare'
      : 'opensip graph --recipe agent-final --gate-compare',
    '```',
    '',
  );

  return lines.join('\n');
}

/** Write AGENTS.md at project root when absent. Returns true when created. */
export function ensureAgentsMd(
  cwd: string,
  opts: { readonly toolScaffolds: readonly ToolScaffold[] },
): boolean {
  const path = join(cwd, 'AGENTS.md');
  if (existsSync(path)) return false;
  writeFileSync(path, buildPlaybook(opts.toolScaffolds), 'utf8');
  return true;
}
