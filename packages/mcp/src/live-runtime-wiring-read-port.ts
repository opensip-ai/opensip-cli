/**
 * Production live runtime wiring projection from captured RunScope facts.
 */

import {
  buildToolIdentityIndex,
  ok,
  type Result,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';

import { readError, type McpReadError } from './mcp-error.js';

import type {
  RuntimeWiringEdge,
  RuntimeWiringNode,
  RuntimeWiringQuery,
  RuntimeWiringReadPort,
  RuntimeWiringResult,
} from './runtime-wiring-read-port.js';

const MAX_NODES = 10_000;
const MAX_EDGES = 20_000;
const MAX_TEXT = 256;

export interface LiveRuntimeWiringDeps {
  readonly projectRoot: string;
  readonly tools: ToolRegistry;
  readonly manifests: readonly ToolPluginManifest[];
  readonly provenance: readonly ToolProvenance[];
}

export class LiveRuntimeWiringReadPort implements RuntimeWiringReadPort {
  private readonly snapshot: RuntimeWiringResult;

  constructor(deps: LiveRuntimeWiringDeps) {
    this.snapshot = buildSnapshot(deps);
  }

  async query(input: RuntimeWiringQuery): Promise<Result<RuntimeWiringResult, McpReadError>> {
    try {
      const limit = Math.min(500, Math.max(1, Math.trunc(input.limit ?? 100)));
      let nodes = this.snapshot.nodes;
      let edges = this.snapshot.edges;
      if (input.tool !== undefined) {
        nodes = nodes.filter((n) => n.tool === input.tool || n.id.includes(input.tool!));
        const ids = new Set(nodes.map((n) => n.id));
        edges = edges.filter((e) => ids.has(e.from) || ids.has(e.to));
      }
      if (input.command !== undefined) {
        nodes = nodes.filter((n) => n.kind === 'command' && n.label.includes(input.command!));
        const ids = new Set(nodes.map((n) => n.id));
        edges = edges.filter((e) => ids.has(e.from) || ids.has(e.to));
      }
      if (input.provenanceSource !== undefined) {
        edges = edges.filter((e) => e.source === input.provenanceSource);
      }
      const truncated =
        nodes.length > limit || this.snapshot.coverage.truncated || edges.length > limit * 2;
      return ok({
        nodes: nodes.slice(0, limit),
        edges: edges.slice(0, limit * 2),
        page: { limit },
        coverage: {
          complete: !truncated && this.snapshot.coverage.complete,
          truncated,
          reasons: [
            ...this.snapshot.coverage.reasons,
            ...(nodes.length > limit ? ['page-limit'] : []),
          ],
        },
        effectiveFilters: input,
      });
    } catch {
      return {
        ok: false,
        error: readError('runtime-wiring-failed', 'Failed to query runtime wiring snapshot.'),
      };
    }
  }
}

function bound(text: string): string {
  const cleaned = text.replaceAll(/[\u0000-\u001f\u007f]/g, '');
  return cleaned.length > MAX_TEXT ? cleaned.slice(0, MAX_TEXT) : cleaned;
}

function buildSnapshot(deps: LiveRuntimeWiringDeps): RuntimeWiringResult {
  const nodes: RuntimeWiringNode[] = [];
  const edges: RuntimeWiringEdge[] = [];
  const reasons: string[] = [];
  let truncated = false;

  // Canonical identity index — proves alias/layout resolution is reused.
  void buildToolIdentityIndex(deps.tools);

  const tools = deps.tools.list() as readonly Tool[];
  const provById = new Map<string, ToolProvenance>();
  for (const p of deps.provenance) {
    const record = p as unknown as Record<string, unknown>;
    const id =
      typeof record['toolId'] === 'string'
        ? record['toolId']
        : typeof record['id'] === 'string'
          ? record['id']
          : typeof record['stableId'] === 'string'
            ? record['stableId']
            : undefined;
    if (id !== undefined) provById.set(id, p);
  }

  for (const manifest of deps.manifests) {
    if (nodes.length >= MAX_NODES) {
      truncated = true;
      reasons.push('node-cap');
      break;
    }
    const m = manifest as unknown as Record<string, unknown>;
    const mid = bound(String(m['id'] ?? m['name'] ?? 'manifest'));
    nodes.push({
      id: `manifest:${mid}`,
      kind: 'manifest',
      label: mid,
      source: 'manifest',
    });
  }

  for (const tool of tools) {
    if (nodes.length >= MAX_NODES) {
      truncated = true;
      reasons.push('node-cap');
      break;
    }
    const toolKey = tool.identity.layoutKey ?? tool.identity.name;
    const tid = `tool:${bound(toolKey)}`;
    nodes.push({
      id: tid,
      kind: 'tool',
      label: bound(tool.identity.name),
      tool: bound(toolKey),
      source: 'registry',
    });

    const toolRecord = tool as unknown as Record<string, unknown>;
    const stable =
      typeof toolRecord['stableId'] === 'string' ? toolRecord['stableId'] : undefined;
    const prov =
      (stable !== undefined ? provById.get(stable) : undefined) ??
      provById.get(toolKey) ??
      provById.get(tool.identity.name);
    if (prov !== undefined) {
      const record = prov as unknown as Record<string, unknown>;
      const source =
        typeof record['source'] === 'string' ? bound(record['source']) : 'provenance';
      // Whitelist posture only — never resolvedPath or manifestHash.
      const posture =
        typeof record['workerPosture'] === 'string' ? bound(record['workerPosture']) : undefined;
      edges.push({
        from: `manifest:${source}`,
        to: tid,
        kind: posture === undefined ? 'manifest-admission' : `manifest-admission:${posture}`,
        source: 'provenance',
        confidence: 'high',
      });
    } else {
      reasons.push('unmatched-provenance');
    }

    for (const spec of tool.commandSpecs ?? []) {
      if (nodes.length >= MAX_NODES || edges.length >= MAX_EDGES) {
        truncated = true;
        reasons.push(nodes.length >= MAX_NODES ? 'node-cap' : 'edge-cap');
        break;
      }
      const cmdName = bound(spec.name);
      const cid = `command:${bound(toolKey)}:${cmdName}`;
      nodes.push({
        id: cid,
        kind: 'command',
        label: cmdName,
        tool: bound(toolKey),
        source: 'command-spec',
      });
      edges.push({
        from: tid,
        to: cid,
        kind: 'registry-command-ownership',
        source: 'registry',
        confidence: 'high',
      });
      edges.push({
        from: cid,
        to: cid,
        kind: 'host-mount-contract',
        source: 'host-contract',
        confidence: 'medium',
        staticBridge: 'partial',
      });
      // Handler dispatch is logical only — never invoke handlers or toString.
      const hid = `handler:${cid}`;
      nodes.push({
        id: hid,
        kind: 'handler',
        label: bound(`${cmdName}#handler`),
        tool: bound(toolKey),
        source: 'command-spec',
      });
      edges.push({
        from: cid,
        to: hid,
        kind: 'command-handler-dispatch',
        source: 'command-spec',
        confidence: 'medium',
        staticBridge: 'unresolved',
      });
    }
  }

  return {
    nodes,
    edges,
    coverage: {
      complete: !truncated,
      truncated,
      reasons: [
        ...new Set([
          ...reasons,
          'tool-command-wiring-complete-for-admitted-registry',
          'top-level-host-commands-not-observed',
        ]),
      ],
    },
    effectiveFilters: {},
  };
}
