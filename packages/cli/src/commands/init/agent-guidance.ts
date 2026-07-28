/**
 * Filesystem adapter for Init's pure managed-agent-guidance renderer.
 *
 * The managed block must keep its operational precedence explicit: use
 * OpenSIP MCP result tools first for existing results. Agents must not grep
 * `.runtime/logs`, read `datastore.sqlite` directly, or re-run an analysis
 * merely to answer a stored-result or history question.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  listAgentGuidanceTargetSpecs,
  MAX_AGENT_GUIDANCE_FILE_BYTES,
  renderAgentGuidanceTargets,
} from './agent-guidance-renderer.js';
import { scaffoldAssetFailure } from './scaffold-asset-failure.js';

import type {
  AgentGuidanceReadFailure,
  AgentGuidanceTargetSnapshot,
  AgentGuidanceTargetSpec,
  RenderedAgentGuidanceTarget,
} from './agent-guidance-renderer.js';
import type { ToolScaffold } from '../shared.js';
import type { AgentGuidanceResult, AgentGuidanceTargetResult } from '@opensip-cli/contracts';

export {
  AGENT_GUIDANCE_END,
  AGENT_GUIDANCE_START,
  buildManagedAgentGuidance,
  listAgentGuidanceTargetSpecs,
  renderAgentGuidanceTargets,
  upsertManagedBlock,
} from './agent-guidance-renderer.js';
export type {
  AgentGuidanceReadFailure,
  AgentGuidanceTargetSnapshot,
  AgentGuidanceTargetSpec,
  RenderedAgentGuidance,
  RenderedAgentGuidanceTarget,
} from './agent-guidance-renderer.js';

function readExistingContent(
  path: string,
): { ok: true; content: string } | { ok: false; reason: AgentGuidanceReadFailure } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { ok: false, reason: 'stat-error' };
  }
  if (size > MAX_AGENT_GUIDANCE_FILE_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  try {
    return { ok: true, content: readFileSync(path, 'utf8') };
  } catch {
    return { ok: false, reason: 'read-error' };
  }
}

function readTargetSnapshot(
  cwd: string,
  spec: AgentGuidanceTargetSpec,
): AgentGuidanceTargetSnapshot {
  const path = join(cwd, spec.relativePath);
  if (!existsSync(path)) {
    return {
      relativePath: spec.relativePath,
      status: 'missing',
      parentExists: existsSync(dirname(path)),
    };
  }

  const existing = readExistingContent(path);
  return existing.ok
    ? {
        relativePath: spec.relativePath,
        status: 'present',
        content: existing.content,
      }
    : {
        relativePath: spec.relativePath,
        status: 'unreadable',
        reason: existing.reason,
      };
}

/** @throws {Error} When a changed guidance target has no rendered content. */
function applyRenderedTarget(
  cwd: string,
  spec: AgentGuidanceTargetSpec,
  target: RenderedAgentGuidanceTarget,
): AgentGuidanceTargetResult {
  const path = join(cwd, target.relativePath);
  if (target.action === 'created' || target.action === 'updated') {
    if (spec.create === 'always') mkdirSync(dirname(path), { recursive: true });
    if (target.content === undefined) {
      scaffoldAssetFailure(
        `Missing rendered guidance bytes: ${target.relativePath}`,
        'snapshot-absent',
        target.relativePath,
      );
    }
    writeFileSync(path, target.content, 'utf8');
  }
  return {
    path,
    action: target.action,
    ...(target.reason === undefined ? {} : { reason: target.reason }),
  };
}

export function ensureOpenSipAgentGuidance(
  cwd: string,
  opts: { readonly toolScaffolds: readonly ToolScaffold[] },
): AgentGuidanceResult {
  const specs = listAgentGuidanceTargetSpecs();
  const rendered = renderAgentGuidanceTargets(
    specs.map((spec) => readTargetSnapshot(cwd, spec)),
    opts,
  );
  const specsByPath = new Map(specs.map((spec) => [spec.relativePath, spec]));
  const targets = rendered.targets.map((target) => {
    const spec = specsByPath.get(target.relativePath);
    if (spec === undefined)
      scaffoldAssetFailure(
        `Unknown rendered guidance target: ${target.relativePath}`,
        'target-unknown',
        target.relativePath,
      );
    return applyRenderedTarget(cwd, spec, target);
  });
  return { changed: rendered.changed, targets };
}
