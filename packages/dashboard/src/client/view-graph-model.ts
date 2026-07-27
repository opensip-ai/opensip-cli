/** Validate the untrusted graph view-model JSON embedded in a generated report. */

import type { GraphViewModel } from './view-graph-elements.js';

export type GraphViewModelLoad =
  { state: 'absent' } | { state: 'malformed' } | { state: 'loaded'; value: GraphViewModel };

function gvIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gvIsNode(value: unknown): boolean {
  if (!gvIsRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.label !== 'string') return false;
  if (
    value.totalCoupling !== undefined &&
    (typeof value.totalCoupling !== 'number' || !Number.isFinite(value.totalCoupling))
  ) {
    return false;
  }
  return value.sccId === undefined || value.sccId === null || typeof value.sccId === 'string';
}

function gvIsEdge(value: unknown): boolean {
  if (!gvIsRecord(value)) return false;
  if (typeof value.source !== 'string' || typeof value.target !== 'string') return false;
  if (
    value.weight !== undefined &&
    (typeof value.weight !== 'number' || !Number.isFinite(value.weight))
  ) {
    return false;
  }
  return value.isCycleEdge === undefined || typeof value.isCycleEdge === 'boolean';
}

export function gvLoadViewModel(): GraphViewModelLoad {
  const blob = document.querySelector('#graph-view-model');
  if (!blob?.textContent) return { state: 'absent' };
  try {
    const parsed: unknown = JSON.parse(blob.textContent);
    if (
      !gvIsRecord(parsed) ||
      !Array.isArray(parsed.nodes) ||
      !parsed.nodes.every((node) => gvIsNode(node)) ||
      !Array.isArray(parsed.edges) ||
      !parsed.edges.every((edge) => gvIsEdge(edge))
    ) {
      return { state: 'malformed' };
    }
    return { state: 'loaded', value: parsed as unknown as GraphViewModel };
  } catch {
    return { state: 'malformed' };
  }
}
