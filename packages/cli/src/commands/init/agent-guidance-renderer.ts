// @fitness-ignore-file no-markdown-references -- this module renders agent instruction markdown by design.
/**
 * Pure, project-relative rendering for Init's managed agent guidance.
 */

import type { ToolScaffold } from '../shared.js';
import type { AgentGuidanceTargetResult } from '@opensip-cli/contracts';

export const AGENT_GUIDANCE_START = '<!-- opensip:agent-guidance start -->';
export const AGENT_GUIDANCE_END = '<!-- opensip:agent-guidance end -->';
export const MAX_AGENT_GUIDANCE_FILE_BYTES = 1024 * 1024;

export interface AgentGuidanceTargetSpec {
  readonly relativePath: string;
  readonly create: 'always' | 'if-parent-exists' | 'never';
  readonly kind: 'playbook' | 'block';
}

const GUIDANCE_TARGETS: readonly AgentGuidanceTargetSpec[] = [
  { relativePath: 'AGENTS.md', create: 'always', kind: 'playbook' },
  { relativePath: 'CLAUDE.md', create: 'never', kind: 'block' },
  {
    relativePath: '.github/copilot-instructions.md',
    create: 'never',
    kind: 'block',
  },
  { relativePath: '.cursorrules', create: 'never', kind: 'block' },
  {
    relativePath: '.cursor/rules/opensip.mdc',
    create: 'if-parent-exists',
    kind: 'block',
  },
  { relativePath: '.windsurfrules', create: 'never', kind: 'block' },
];

type ToolScaffoldLayout = Pick<ToolScaffold, 'layout'>;

export type AgentGuidanceReadFailure = 'stat-error' | 'too-large' | 'read-error';

export type AgentGuidanceTargetSnapshot =
  | {
      readonly relativePath: string;
      readonly status: 'missing';
      readonly parentExists: boolean;
    }
  | {
      readonly relativePath: string;
      readonly status: 'present';
      readonly content: string;
    }
  | {
      readonly relativePath: string;
      readonly status: 'unreadable';
      readonly reason: AgentGuidanceReadFailure;
    };

export interface RenderedAgentGuidanceTarget {
  readonly relativePath: string;
  readonly action: AgentGuidanceTargetResult['action'];
  readonly reason?: string;
  /** Exact desired bytes for created, updated, and unchanged targets. */
  readonly content?: string;
}

export interface RenderedAgentGuidance {
  readonly changed: boolean;
  readonly targets: readonly RenderedAgentGuidanceTarget[];
}

export function listAgentGuidanceTargetSpecs(): readonly AgentGuidanceTargetSpec[] {
  return GUIDANCE_TARGETS.map((target) => ({ ...target }));
}

function hasFitDomain(toolScaffolds: readonly ToolScaffoldLayout[]): boolean {
  return toolScaffolds.some((toolScaffold) => toolScaffold.layout.domain === 'fit');
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
    '1. OpenSIP MCP tools: `get_agent_catalog`, `list_runs`, `show_run`, `get_latest_findings`, `get_architecture`, `search_symbols`, `search_declarations`, `references_to`, `who_calls`, `callees_of`, `blast_radius`, `package_dependencies`, `why_depends`, `package_cycles`, `get_runtime_wiring`.',
    '2. `opensip sessions ...` replay commands when MCP is unavailable.',
    '3. Re-run `opensip fit`, `opensip graph`, `opensip yagni`, or `opensip sim` only when fresh execution is explicitly needed.',
    '4. Raw logs or direct datastore inspection only as a last-resort debugging path.',
    '',
    'Graph audit notes:',
    '',
    '- Call `get_agent_catalog` first for live surface diagnosis (version, surface epoch, registered names/count, mutation posture, project root). Compare with initialize/listTools. A mismatched surface epoch or tool names means reconnect the MCP client/process — `refresh_graph` cannot repair a stale connector inventory.',
    '- Verify the canonical configured project context first, including `context.project.root`, then the opaque `g1:` catalog generation identity in `context.catalog.identity`. The project key is a separate cursor binding only; never treat it as response context or infer it from an opaque cursor.',
    '- Inspect freshness `complete` versus `partial`, reason codes, effective filters, evidence kind/confidence, and the four coverage facets (inventory / evidence / grouping / projection) — noting per-facet hard-cap reasons and cursor continuation — before claiming complete coverage. Sample or page caps must not invalidate a complete inventory.',
    '- Ordinary MCP graph reads auto-load a newer catalog already persisted by `opensip graph`; they never build one. Use `refresh_graph` only when missing/stale graph evidence explicitly requires a fresh build, not merely because an external graph run just finished, and never to fix a stale connector.',
    '- Prefer exclusive compact detail modes (`summary` / `groups` / `nodes`). Identity searches (`search_symbols`, `search_declarations`) default to 20 nodes. Request package samples, cycle proofs, and reference sites only when needed.',
    '- Traversal defaults to occurrence identity; body-twin union is explicit. Use `package_dependencies`, `why_depends`, and `package_cycles` for labelled call/import package evidence. Use `search_declarations` then `references_to` for cross-file type/interface references (exact TypeScript only; declaration IDs are not callable symbolIds). Use `get_runtime_wiring` for live command inventory (`w1:`) and author-declared static-handler bridges against `g1:` — runtime edges, not call edges.',
    '- Continue bounded pages with the returned cursor and keep filters stable. Do not loop `refresh_graph` per query.',
    '',
    'Do not grep `.runtime/logs` or read `datastore.sqlite` directly to answer result/history questions; logs are event streams and may not match stored session semantics.',
    AGENT_GUIDANCE_END,
  ].join('\n');
}

function buildPlaybook(toolScaffolds: readonly ToolScaffoldLayout[]): string {
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
      'Prepare bounded before-edit evidence for the explicit task files, then use the composed audit suite after editing.',
      '',
      '```bash',
      'opensip suite run agent-context --files src/example.ts --json',
      'opensip audit --json',
      'opensip fit --recipe agent-fast --json --filter errors-only',
      'opensip graph impact --changed --json --top 20',
      'opensip fit --changed --include-impacted --json',
      '```',
      '',
      'Read `graph impact` JSON `trust.fullyVerified` before claiming targeted verification; `fit --changed --include-impacted` falls back to a full target set when impact trust is partial or unknown.',
    );
  } else {
    lines.push(
      'Prepare bounded before-edit evidence for the explicit task files, then use the composed audit suite after editing.',
      '',
      '```bash',
      'opensip suite run agent-context --files src/example.ts --json',
      'opensip audit --json',
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

export function renderAgentGuidanceTargets(
  snapshots: readonly AgentGuidanceTargetSnapshot[],
  opts: { readonly toolScaffolds: readonly ToolScaffoldLayout[] },
): RenderedAgentGuidance {
  const snapshotsByPath = indexTargetSnapshots(snapshots);
  const block = buildManagedAgentGuidance();
  const targets = GUIDANCE_TARGETS.map((spec) => {
    const snapshot = snapshotsByPath.get(spec.relativePath);
    if (snapshot === undefined) {
      throw new Error(`Missing agent-guidance snapshot: ${spec.relativePath}`);
    }
    return renderTarget(spec, snapshot, opts.toolScaffolds, block);
  });
  return {
    changed: targets.some((target) => target.action === 'created' || target.action === 'updated'),
    targets,
  };
}

function indexTargetSnapshots(
  snapshots: readonly AgentGuidanceTargetSnapshot[],
): ReadonlyMap<string, AgentGuidanceTargetSnapshot> {
  const knownPaths = new Set(GUIDANCE_TARGETS.map((target) => target.relativePath));
  const indexed = new Map<string, AgentGuidanceTargetSnapshot>();
  for (const snapshot of snapshots) {
    if (!knownPaths.has(snapshot.relativePath)) {
      throw new Error(`Unknown agent-guidance target: ${snapshot.relativePath}`);
    }
    if (indexed.has(snapshot.relativePath)) {
      throw new Error(`Duplicate agent-guidance snapshot: ${snapshot.relativePath}`);
    }
    indexed.set(snapshot.relativePath, snapshot);
  }
  return indexed;
}

function renderTarget(
  spec: AgentGuidanceTargetSpec,
  snapshot: AgentGuidanceTargetSnapshot,
  toolScaffolds: readonly ToolScaffoldLayout[],
  block: string,
): RenderedAgentGuidanceTarget {
  if (snapshot.status === 'unreadable') {
    return {
      relativePath: spec.relativePath,
      action: 'skipped',
      reason: snapshot.reason,
    };
  }
  if (snapshot.status === 'missing') {
    if (spec.create === 'never') {
      return { relativePath: spec.relativePath, action: 'skipped', reason: 'missing' };
    }
    if (spec.create === 'if-parent-exists' && !snapshot.parentExists) {
      return {
        relativePath: spec.relativePath,
        action: 'skipped',
        reason: 'parent-missing',
      };
    }
    return {
      relativePath: spec.relativePath,
      action: 'created',
      content: spec.kind === 'playbook' ? buildPlaybook(toolScaffolds) : `${block}\n`,
    };
  }
  if (Buffer.byteLength(snapshot.content, 'utf8') > MAX_AGENT_GUIDANCE_FILE_BYTES) {
    return { relativePath: spec.relativePath, action: 'skipped', reason: 'too-large' };
  }
  const rendered = upsertManagedBlock(snapshot.content, block);
  return {
    relativePath: spec.relativePath,
    action: rendered.changed ? 'updated' : 'unchanged',
    content: rendered.content,
  };
}
