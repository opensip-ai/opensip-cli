// @fitness-ignore-file no-markdown-references -- this module manages agent instruction markdown files by design.
/**
 * Managed OpenSIP agent guidance blocks for `opensip init`.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ToolScaffold } from '../shared.js';
import type { AgentGuidanceResult, AgentGuidanceTargetResult } from '@opensip-cli/contracts';

export const AGENT_GUIDANCE_START = '<!-- opensip:agent-guidance start -->';
export const AGENT_GUIDANCE_END = '<!-- opensip:agent-guidance end -->';

const MAX_AGENT_FILE_BYTES = 1024 * 1024;

interface GuidanceTargetSpec {
  readonly relativePath: string;
  readonly create: 'always' | 'if-parent-exists' | 'never';
  readonly kind: 'playbook' | 'block';
}

const GUIDANCE_TARGETS: readonly GuidanceTargetSpec[] = [
  { relativePath: 'AGENTS.md', create: 'always', kind: 'playbook' },
  { relativePath: 'CLAUDE.md', create: 'never', kind: 'block' },
  { relativePath: '.github/copilot-instructions.md', create: 'never', kind: 'block' },
  { relativePath: '.cursorrules', create: 'never', kind: 'block' },
  { relativePath: '.cursor/rules/opensip.mdc', create: 'if-parent-exists', kind: 'block' },
  { relativePath: '.windsurfrules', create: 'never', kind: 'block' },
];

function hasFitDomain(toolScaffolds: readonly ToolScaffold[]): boolean {
  return toolScaffolds.some((t) => t.layout.domain === 'fit');
}

function normalizeNewlines(text: string, newline: string): string {
  return text.replace(/\r?\n/g, newline);
}

function detectNewline(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function replaceMarkerLine(
  content: string,
  markerIndex: number,
  replacement: string,
  newline: string,
): string {
  const lineStart = content.lastIndexOf('\n', markerIndex - 1) + 1;
  const nextLineStart = content.indexOf('\n', markerIndex);
  const lineEnd = nextLineStart === -1 ? content.length : nextLineStart + 1;
  return `${content.slice(0, lineStart)}${replacement}${newline}${content.slice(lineEnd)}`;
}

export function buildManagedAgentGuidance(): string {
  return [
    AGENT_GUIDANCE_START,
    '## OpenSIP MCP First',
    '',
    'When answering questions about existing OpenSIP results, prior `fit` / `graph` / `yagni` / `sim` runs, findings, warnings, errors, scores, sessions, or graph relationships, use the OpenSIP MCP server first.',
    '',
    'Source precedence:',
    '',
    '1. OpenSIP MCP tools: `list_runs`, `show_run`, `get_latest_findings`, `search_symbols`, `who_calls`, `callees_of`, `blast_radius`, `package_dependencies`, `why_depends`, `package_cycles`, `get_runtime_wiring`.',
    '2. `opensip sessions ...` replay commands when MCP is unavailable.',
    '3. Re-run `opensip fit`, `opensip graph`, `opensip yagni`, or `opensip sim` only when fresh execution is explicitly needed.',
    '4. Raw logs or direct datastore inspection only as a last-resort debugging path.',
    '',
    'Graph audit notes:',
    '',
    '- Verify the canonical configured project context first, including `context.project.root`, then the opaque `g1:` catalog generation identity in `context.catalog.identity`. The project key is a separate cursor binding only; never treat it as response context or infer it from an opaque cursor.',
    '- Inspect freshness `complete` versus `partial`, reason codes, effective filters, evidence kind/confidence, `truncated`, hard-cap reasons, and cursor continuation before claiming complete coverage.',
    '- Ordinary MCP graph reads auto-load a newer catalog already persisted by `opensip graph`; they never build one. Use `refresh_graph` only when missing/stale evidence explicitly requires a fresh build, not merely because an external graph run just finished.',
    '- Traversal defaults to occurrence identity; body-twin union is explicit. Use `package_dependencies`, `why_depends`, and `package_cycles` for labelled call/import package evidence. Use `get_runtime_wiring` for live manifest/registry/CommandSpec paths that are not static call edges.',
    '- Continue bounded pages with the returned cursor and keep filters stable. Do not loop `refresh_graph` per query.',
    '',
    'Do not grep `.runtime/logs` or read `datastore.sqlite` directly to answer result/history questions; logs are event streams and may not match stored session semantics.',
    AGENT_GUIDANCE_END,
  ].join('\n');
}

function buildPlaybook(toolScaffolds: readonly ToolScaffold[]): string {
  const lines = [
    '# OpenSIP Agent Playbook',
    '',
    'Machine-first workflow for coding agents using OpenSIP CLI.',
    '',
    buildManagedAgentGuidance(),
    '',
    '## Product intent',
    '',
    'OpenSIP is the guardrail layer for trustworthy AI-assisted development. It does not call models or autonomously change code; it gives agents and humans deterministic evidence through checks, graph context, sessions, gates, and MCP.',
    '',
    'Treat failures as product feedback. Do not bypass guardrails to make a task pass. Fix the code, narrow the scope, or ask for a documented rule change.',
    '',
    '## Discover',
    '',
    '```bash',
    'opensip agent-catalog --json',
    '```',
    '',
    '## Read latest results first',
    '',
    'When MCP is unavailable and the user references existing findings, inspect the latest stored result before re-running:',
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
      'Start PR review with the composed audit suite. It runs changed-code risk, graph impact, and high-confidence reduction candidates in one command.',
      '',
      '```bash',
      'opensip suite run audit --json',
      'opensip fit --recipe agent-fast --json --filter errors-only',
      'opensip graph impact --changed --json --top 20',
      'opensip fit --changed --include-impacted --json',
      '```',
      '',
      'Read `graph impact` JSON `trust.fullyVerified` before claiming targeted verification; `fit --changed --include-impacted` falls back to a full target set when impact trust is partial or unknown.',
    );
  } else {
    lines.push(
      'Start PR review with the composed audit suite. It runs changed-code risk, graph impact, and high-confidence reduction candidates in one command.',
      '',
      '```bash',
      'opensip suite run audit --json',
      'opensip graph impact --changed --json --top 20',
      '```',
      '',
      'Read `graph impact` JSON `trust.fullyVerified` before claiming targeted verification.',
    );
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

export function upsertManagedBlock(
  content: string,
  block: string,
): { readonly content: string; readonly changed: boolean } {
  const newline = detectNewline(content);
  const normalizedBlock = normalizeNewlines(block, newline);
  const start = content.indexOf(AGENT_GUIDANCE_START);
  const end = content.indexOf(AGENT_GUIDANCE_END, start + AGENT_GUIDANCE_START.length);

  if (start >= 0 && end >= start) {
    const replacementEnd = end + AGENT_GUIDANCE_END.length;
    const next = `${content.slice(0, start)}${normalizedBlock}${content.slice(replacementEnd)}`;
    return { content: next, changed: next !== content };
  }

  if (start >= 0) {
    const next = replaceMarkerLine(content, start, normalizedBlock, newline);
    return { content: next, changed: next !== content };
  }

  const insertAt = findInsertionPoint(content, newline);
  const needsLeadingNewline = insertAt > 0 && !content.slice(0, insertAt).endsWith(newline);
  const needsTrailingNewline =
    content.length > insertAt && !content.slice(insertAt).startsWith(newline);
  const insertion = `${needsLeadingNewline ? newline : ''}${normalizedBlock}${newline}${
    needsTrailingNewline ? newline : ''
  }`;
  const next = `${content.slice(0, insertAt)}${insertion}${content.slice(insertAt)}`;
  return { content: next, changed: next !== content };
}

function findInsertionPoint(content: string, newline: string): number {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  if (frontmatter?.[0]) {
    let index = frontmatter[0].length;
    if (content.slice(index).startsWith(newline)) index += newline.length;
    return index;
  }

  const title = /^# .*(?:\r?\n)?/.exec(content);
  if (title?.[0]) {
    let index = title[0].length;
    if (content.slice(index).startsWith(newline)) index += newline.length;
    return index;
  }

  return 0;
}

function readExistingContent(
  path: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { ok: false, reason: 'stat-error' };
  }
  if (size > MAX_AGENT_FILE_BYTES) return { ok: false, reason: 'too-large' };
  try {
    return { ok: true, content: readFileSync(path, 'utf8') };
  } catch {
    return { ok: false, reason: 'read-error' };
  }
}

function writeTarget(
  cwd: string,
  spec: GuidanceTargetSpec,
  opts: { readonly toolScaffolds: readonly ToolScaffold[]; readonly block: string },
): AgentGuidanceTargetResult {
  const path = join(cwd, spec.relativePath);
  const exists = existsSync(path);

  if (!exists) {
    if (spec.create === 'never') return { path, action: 'skipped', reason: 'missing' };
    const parent = dirname(path);
    if (spec.create === 'if-parent-exists' && !existsSync(parent)) {
      return { path, action: 'skipped', reason: 'parent-missing' };
    }
    if (spec.create === 'always') mkdirSync(parent, { recursive: true });
    const content =
      spec.kind === 'playbook' ? buildPlaybook(opts.toolScaffolds) : `${opts.block}\n`;
    writeFileSync(path, content, 'utf8');
    return { path, action: 'created' };
  }

  const existing = readExistingContent(path);
  if (!existing.ok) return { path, action: 'skipped', reason: existing.reason };

  const { content, changed } = upsertManagedBlock(existing.content, opts.block);
  if (!changed) return { path, action: 'unchanged' };
  writeFileSync(path, content, 'utf8');
  return { path, action: 'updated' };
}

export function ensureOpenSipAgentGuidance(
  cwd: string,
  opts: { readonly toolScaffolds: readonly ToolScaffold[] },
): AgentGuidanceResult {
  const block = buildManagedAgentGuidance();
  const targets = GUIDANCE_TARGETS.map((spec) => writeTarget(cwd, spec, { ...opts, block }));
  return {
    changed: targets.some((target) => target.action === 'created' || target.action === 'updated'),
    targets,
  };
}
