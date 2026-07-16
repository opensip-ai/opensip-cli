import { realpathSync } from 'node:fs';

import {
  assessImpactTrust,
  testSelectionGraphBindingIsValid,
} from '../model/context-surface-trust.js';
import { boundedUtf8Prefix, isUnknownRecord as isRecord } from '../model/value-helpers.js';

import {
  codebaseContextIsValid,
  extractCodebaseCoverage,
  extractCodebaseFreshness,
} from './opensip-mcp-codebase-envelope.js';

import type { StepCoverage, StepFreshness } from '../model/record.js';

const GRAPH_READ_TOOLS = new Set([
  'blast_radius',
  'callees_of',
  'find_dead_code',
  'get_architecture',
  'get_symbol',
  'impact_files',
  'package_cycles',
  'package_dependencies',
  'references_to',
  'refresh_graph',
  'search_declarations',
  'search_symbols',
  'select_tests',
  'trace_path',
  'who_calls',
  'why_depends',
]);
const RUNTIME_READ_TOOLS = new Set(['get_runtime_wiring']);
const CODEBASE_READ_TOOLS = new Set(['get_file_context']);

export interface DecodedResult {
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly failure?: {
    readonly code: string;
    readonly kind: 'protocol' | 'tool';
    readonly message: string;
  };
  readonly rendered: string;
  readonly truncated: boolean;
}

export interface ToolEnvelopeMetadata {
  readonly catalogIdentity?: string;
  readonly coverage?: StepCoverage;
  readonly failure?: {
    readonly code:
      'invalid-codebase-envelope' | 'invalid-graph-envelope' | 'invalid-runtime-envelope';
    readonly message: string;
  };
  readonly freshness?: StepFreshness;
  readonly nextCursor?: string;
}

export function decodeToolResult(result: unknown, maximumBytes: number): DecodedResult {
  if (!isRecord(result)) {
    return {
      failure: {
        code: 'malformed-mcp-result',
        kind: 'protocol',
        message: 'MCP tool returned a non-object result.',
      },
      rendered: '',
      truncated: false,
    };
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    return {
      failure: {
        code: 'missing-mcp-content',
        kind: 'protocol',
        message: 'MCP tool did not return one content item.',
      },
      rendered: '',
      truncated: false,
    };
  }
  const content: unknown[] = result.content;
  const first: unknown = content[0];
  if (!isRecord(first) || first.type !== 'text' || typeof first.text !== 'string') {
    return {
      failure: {
        code: 'non-text-mcp-content',
        kind: 'protocol',
        message: 'MCP tool returned non-text content.',
      },
      rendered: '',
      truncated: false,
    };
  }
  const rendered = boundedUtf8Prefix(first.text, maximumBytes);
  const truncated = Buffer.byteLength(first.text, 'utf8') > maximumBytes;
  if (truncated) {
    return {
      failure: {
        code: 'mcp-response-limit',
        kind: 'protocol',
        message: 'MCP tool response exceeded the harness byte ceiling.',
      },
      rendered,
      truncated: true,
    };
  }
  if (result.isError === true) {
    return {
      failure: {
        code: 'mcp-tool-error',
        kind: 'tool',
        message: 'MCP tool returned an error result.',
      },
      rendered,
      truncated: false,
    };
  }
  try {
    const payload = JSON.parse(rendered) as unknown;
    if (!isRecord(payload)) throw new TypeError('payload is not an object');
    return { payload, rendered, truncated: false };
  } catch {
    return {
      failure: {
        code: 'invalid-mcp-json',
        kind: 'protocol',
        message: 'MCP tool returned invalid JSON text.',
      },
      rendered,
      truncated: false,
    };
  }
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return undefined;
  }
  return value as string[];
}

function extractCoverage(payload: Readonly<Record<string, unknown>>): StepCoverage | undefined {
  if (!isRecord(payload.coverage)) return undefined;
  const coverage = payload.coverage;
  if (typeof coverage.complete !== 'boolean' || typeof coverage.truncated !== 'boolean') {
    return undefined;
  }
  const facetNames = ['inventory', 'evidence', 'grouping', 'projection'] as const;
  const facets = facetNames.flatMap((name) => {
    const facet = coverage[name];
    if (
      !isRecord(facet) ||
      typeof facet.complete !== 'boolean' ||
      typeof facet.requested !== 'boolean' ||
      typeof facet.truncated !== 'boolean'
    ) {
      return [];
    }
    const reasons = readStringArray(facet.reasons);
    if (reasons === undefined) return [];
    return [
      {
        complete: facet.complete,
        hardCapReasons: reasons,
        name,
        requested: facet.requested,
        truncated: facet.truncated,
      },
    ];
  });
  if (facets.length !== facetNames.length) return undefined;
  const reasons = readStringArray(coverage.reasons);
  const requested = facets.filter((facet) => facet.requested);
  if (
    reasons === undefined ||
    coverage.complete !== requested.every((facet) => facet.complete) ||
    coverage.truncated !== requested.some((facet) => facet.truncated)
  ) {
    return undefined;
  }
  return {
    complete: coverage.complete,
    facets,
    hardCapReasons: reasons,
    truncated: coverage.truncated,
  };
}

function extractNextCursor(payload: Readonly<Record<string, unknown>>): string | undefined {
  if (!isRecord(payload.page)) return undefined;
  return typeof payload.page.nextCursor === 'string' && payload.page.nextCursor.length > 0
    ? payload.page.nextCursor
    : undefined;
}

function graphPageIsValid(payload: Readonly<Record<string, unknown>>): boolean {
  if (payload.page === undefined) return true;
  if (!isRecord(payload.page) || !Number.isSafeInteger(payload.page.limit)) return false;
  return (
    payload.page.nextCursor === undefined ||
    (typeof payload.page.nextCursor === 'string' && payload.page.nextCursor.length > 0)
  );
}

function extractFreshness(payload: Readonly<Record<string, unknown>>): StepFreshness | undefined {
  if (!isRecord(payload.freshness)) return undefined;
  const freshness = payload.freshness;
  if (
    typeof freshness.fresh !== 'boolean' ||
    (freshness.verification !== 'complete' &&
      freshness.verification !== 'missing' &&
      freshness.verification !== 'partial')
  ) {
    return undefined;
  }
  return {
    fresh: freshness.fresh,
    ...(typeof freshness.reasonCode === 'string' ? { reasonCode: freshness.reasonCode } : {}),
    verification: freshness.verification,
  };
}

function extractCatalogIdentity(payload: Readonly<Record<string, unknown>>): string | undefined {
  if (!isRecord(payload.context) || !isRecord(payload.context.catalog)) return undefined;
  return typeof payload.context.catalog.identity === 'string'
    ? payload.context.catalog.identity
    : undefined;
}

function isSameCanonicalRoot(value: unknown, expectedRoot: string): boolean {
  if (typeof value !== 'string') return false;
  let canonicalRoot: string | undefined;
  try {
    canonicalRoot = realpathSync(value);
  } catch {
    canonicalRoot = undefined;
  }
  return canonicalRoot === expectedRoot;
}

function graphContextIsValid(
  payload: Readonly<Record<string, unknown>>,
  projectRoot: string,
  freshness: StepFreshness | undefined,
): boolean {
  if (
    !isRecord(payload.context) ||
    !isRecord(payload.context.project) ||
    !isSameCanonicalRoot(payload.context.project.root, projectRoot) ||
    payload.context.project.scope !== 'project' ||
    !isRecord(payload.context.catalog)
  ) {
    return false;
  }
  const catalog = payload.context.catalog;
  if (catalog.status === 'missing') {
    return (
      catalog.identity === undefined &&
      freshness?.fresh === false &&
      freshness.verification === 'missing'
    );
  }
  return (
    catalog.status === 'loaded' &&
    typeof catalog.identity === 'string' &&
    catalog.identity.startsWith('g1:')
  );
}

function markImpactCoverageIncomplete(
  coverage: StepCoverage,
  reasonCodes: readonly string[],
): StepCoverage {
  const reasons = [...new Set([...(coverage.hardCapReasons ?? []), ...reasonCodes])];
  const facets = coverage.facets?.map((facet) =>
    facet.name === 'projection'
      ? {
          ...facet,
          complete: false,
          hardCapReasons: [...new Set([...(facet.hardCapReasons ?? []), ...reasonCodes])],
          requested: true,
        }
      : facet,
  );
  return {
    ...coverage,
    complete: false,
    ...(facets === undefined ? {} : { facets }),
    hardCapReasons: reasons,
  };
}

function extractRuntimeCoverage(
  payload: Readonly<Record<string, unknown>>,
): StepCoverage | undefined {
  if (!isRecord(payload.coverage)) return undefined;
  const coverage = payload.coverage;
  const reasons = readStringArray(coverage.reasons);
  if (
    typeof coverage.complete !== 'boolean' ||
    coverage.scope !== 'captured-admitted-registry-and-command-inventory' ||
    typeof coverage.truncated !== 'boolean' ||
    reasons === undefined
  ) {
    return undefined;
  }
  return {
    complete: coverage.complete,
    hardCapReasons: reasons,
    truncated: coverage.truncated,
  };
}

function runtimeContextIsValid(
  payload: Readonly<Record<string, unknown>>,
  projectRoot: string,
  coverage: StepCoverage | undefined,
): boolean {
  if (
    !isRecord(payload.context) ||
    !isRecord(payload.context.project) ||
    !isSameCanonicalRoot(payload.context.project.root, projectRoot) ||
    payload.context.project.scope !== 'project' ||
    !isRecord(payload.context.runtime) ||
    payload.context.runtime.kind !== 'runtime-wiring' ||
    typeof payload.context.runtime.identity !== 'string' ||
    !payload.context.runtime.identity.startsWith('w1:') ||
    !isRecord(payload.page) ||
    !Number.isSafeInteger(payload.page.limit) ||
    typeof payload.page.hasMore !== 'boolean' ||
    typeof payload.page.edgeTruncated !== 'boolean' ||
    typeof payload.groupTruncated !== 'boolean' ||
    coverage === undefined
  ) {
    return false;
  }
  const cursorIsValid = payload.page.hasMore
    ? typeof payload.page.nextCursor === 'string' && payload.page.nextCursor.length > 0
    : payload.page.nextCursor === undefined;
  const projectedTruncation = payload.page.edgeTruncated || payload.groupTruncated;
  return cursorIsValid && (!projectedTruncation || (coverage.truncated && !coverage.complete));
}

export function inspectToolEnvelope(
  payload: Readonly<Record<string, unknown>>,
  tool: string,
  projectRoot: string,
): ToolEnvelopeMetadata {
  const graphRead = GRAPH_READ_TOOLS.has(tool);
  const runtimeRead = RUNTIME_READ_TOOLS.has(tool);
  const codebaseRead = CODEBASE_READ_TOOLS.has(tool);
  let coverage = extractCoverage(payload);
  let freshness = extractFreshness(payload);
  if (runtimeRead) coverage = extractRuntimeCoverage(payload);
  if (codebaseRead) {
    coverage = extractCodebaseCoverage(payload);
    freshness = extractCodebaseFreshness(payload);
  }
  const impactTrust = tool === 'impact_files' ? assessImpactTrust(payload) : undefined;
  const selectionBindingValid =
    tool !== 'select_tests' || testSelectionGraphBindingIsValid(payload);
  if (
    graphRead &&
    (coverage === undefined ||
      freshness === undefined ||
      !graphContextIsValid(payload, projectRoot, freshness) ||
      !graphPageIsValid(payload) ||
      impactTrust?.valid === false ||
      !selectionBindingValid)
  ) {
    return {
      failure: {
        code: 'invalid-graph-envelope',
        message: 'MCP graph read omitted or malformed required trust metadata.',
      },
    };
  }
  if (impactTrust?.valid === true && !impactTrust.fullyVerified && coverage !== undefined) {
    coverage = markImpactCoverageIncomplete(coverage, impactTrust.reasonCodes);
  }
  if (
    runtimeRead &&
    (coverage === undefined || !runtimeContextIsValid(payload, projectRoot, coverage))
  ) {
    return {
      failure: {
        code: 'invalid-runtime-envelope',
        message: 'MCP runtime wiring read omitted or malformed required trust metadata.',
      },
    };
  }
  if (codebaseRead && !codebaseContextIsValid(payload, coverage, freshness)) {
    return {
      failure: {
        code: 'invalid-codebase-envelope',
        message: 'MCP codebase read omitted or malformed required trust metadata.',
      },
    };
  }
  return {
    ...(coverage === undefined ? {} : { coverage }),
    ...(freshness === undefined ? {} : { freshness }),
    catalogIdentity: extractCatalogIdentity(payload),
    nextCursor: extractNextCursor(payload),
  };
}
