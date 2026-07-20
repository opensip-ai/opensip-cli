import { realpathSync } from 'node:fs';

import { isUnknownRecord as isRecord } from '../model/value-helpers.js';
import { HarnessPrerequisiteError } from '../runner/spawn.js';

import type { McpServerVersion } from './opensip-mcp-connection.js';

const EXPECTED_SERVER_NAME = 'opensip-cli-mcp';
const MAX_HANDSHAKE_STRING_BYTES = 4096;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_TOOL_COUNT = 256;
export const EXPECTED_MCP_SURFACE_EPOCH = 8;

/** MCP capabilities required by harness setup and every registered OpenSIP strategy. */
export const REQUIRED_MCP_TOOL_NAMES: readonly string[] = Object.freeze([
  'callees_of',
  'get_agent_catalog',
  'get_architecture',
  'get_context_status',
  'get_file_context',
  'get_symbol',
  'impact_files',
  'package_dependencies',
  'references_to',
  'refresh_graph',
  'search_declarations',
  'search_symbols',
  'select_tests',
  'trace_path',
  'who_calls',
]);

/** Canonical read-only MCP surface proven during session setup. */
export interface VerifiedSurface {
  readonly mutationPosture: 'read-only';
  readonly projectRoot: string;
  readonly projectScope: 'project';
  readonly surfaceEpoch: number;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly version: string;
}

/**
 * Require an object at one MCP handshake path.
 *
 * @throws {HarnessPrerequisiteError} When the value is not a record.
 */
function requiredRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new HarnessPrerequisiteError(`MCP handshake returned an invalid ${path} object.`);
  }
  return value;
}

/**
 * Require a non-empty string at one MCP handshake path.
 *
 * @throws {HarnessPrerequisiteError} When the value is not a non-empty string.
 */
function requiredString(
  value: unknown,
  path: string,
  maximumBytes = MAX_HANDSHAKE_STRING_BYTES,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new HarnessPrerequisiteError(`MCP handshake returned an invalid ${path} string.`);
  }
  return value;
}

/**
 * Require a safe integer at one MCP handshake path.
 *
 * @throws {HarnessPrerequisiteError} When the value is not a safe integer.
 */
function requiredInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HarnessPrerequisiteError(`MCP handshake returned an invalid ${path} integer.`);
  }
  return value;
}

/**
 * Validate, deduplicate, and deterministically sort a handshake name list.
 *
 * @throws {HarnessPrerequisiteError} When the list is malformed or contains duplicates.
 */
function sortedUniqueNames(value: unknown, path: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_TOOL_COUNT ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        item.length === 0 ||
        Buffer.byteLength(item, 'utf8') > MAX_TOOL_NAME_BYTES ||
        /\p{C}/u.test(item),
    )
  ) {
    throw new HarnessPrerequisiteError(`MCP handshake returned an invalid ${path} list.`);
  }
  const names = value as string[];
  if (new Set(names).size !== names.length) {
    throw new HarnessPrerequisiteError(`MCP handshake returned duplicate names in ${path}.`);
  }
  return [...names].sort((left, right) => {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

/**
 * Extract the single text item from a successful catalog tool result.
 *
 * @throws {HarnessPrerequisiteError} When the result is erroneous or has an invalid shape.
 */
function textContent(result: unknown): string {
  const resultRecord = requiredRecord(result, 'get_agent_catalog result');
  if (resultRecord.isError === true) {
    throw new HarnessPrerequisiteError('MCP get_agent_catalog returned an error.');
  }
  const content = resultRecord.content;
  if (!Array.isArray(content) || content.length !== 1) {
    throw new HarnessPrerequisiteError(
      'MCP get_agent_catalog did not return one text content item.',
    );
  }
  const first = requiredRecord(content[0], 'get_agent_catalog content');
  if (first.type !== 'text' || typeof first.text !== 'string') {
    throw new HarnessPrerequisiteError('MCP get_agent_catalog returned non-text content.');
  }
  return first.text;
}

/**
 * Bound a materialized SDK handshake response before traversing arrays or
 * parsing embedded JSON.
 *
 * @throws {HarnessPrerequisiteError} When serialization fails or exceeds the configured ceiling.
 */
function assertResponseWithinByteLimit(value: unknown, path: string, maximumBytes: number): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new HarnessPrerequisiteError(`MCP ${path} exceeded the handshake byte ceiling.`);
  }
}

/**
 * Parse and validate the agent-catalog object returned during MCP setup.
 *
 * @throws {HarnessPrerequisiteError} When content is malformed, non-text, or invalid JSON.
 */
export function parseCatalogResult(
  result: unknown,
  maximumBytes: number,
): Readonly<Record<string, unknown>> {
  assertResponseWithinByteLimit(result, 'get_agent_catalog response', maximumBytes);
  try {
    return requiredRecord(JSON.parse(textContent(result)), 'agent catalog');
  } catch (error) {
    if (error instanceof HarnessPrerequisiteError) throw error;
    throw new HarnessPrerequisiteError('MCP get_agent_catalog returned invalid JSON.');
  }
}

/**
 * Extract a sorted, unique tool-name inventory from `listTools`.
 *
 * @throws {HarnessPrerequisiteError} When the response or a tool descriptor is malformed.
 */
export function listToolNames(result: unknown, maximumBytes: number): readonly string[] {
  assertResponseWithinByteLimit(result, 'listTools response', maximumBytes);
  const response = requiredRecord(result, 'listTools result');
  if (!Array.isArray(response.tools) || response.tools.length > MAX_TOOL_COUNT) {
    throw new HarnessPrerequisiteError('MCP listTools returned an invalid tools list.');
  }
  return sortedUniqueNames(
    response.tools.map((tool) => requiredRecord(tool, 'tool descriptor').name),
    'listTools names',
  );
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function addViolation(violations: string[], violated: boolean, message: string): void {
  if (violated) violations.push(message);
}

/**
 * Verify catalog, initialize, listTools, posture, and canonical project-root agreement.
 *
 * @throws {Error} When roots cannot be canonicalized or any MCP surface invariant fails.
 */
export function verifySurface(
  catalog: Readonly<Record<string, unknown>>,
  listedToolNames: readonly string[],
  serverVersion: McpServerVersion | undefined,
  workspaceRoot: string,
): VerifiedSurface {
  const mcp = requiredRecord(catalog.mcp, 'agent catalog mcp');
  const version = requiredString(mcp.version, 'mcp.version');
  const surfaceEpoch = requiredInteger(mcp.surfaceEpoch, 'mcp.surfaceEpoch');
  const toolNames = sortedUniqueNames(mcp.toolNames, 'mcp.toolNames');
  const toolCount = requiredInteger(mcp.toolCount, 'mcp.toolCount');
  const project = requiredRecord(mcp.project, 'mcp.project');
  const projectRoot = requiredString(project.root, 'mcp.project.root');
  const canonicalWorkspaceRoot = realpathSync(workspaceRoot);
  const canonicalProjectRoot = realpathSync(projectRoot);

  const violations: string[] = [];
  addViolation(
    violations,
    surfaceEpoch !== EXPECTED_MCP_SURFACE_EPOCH,
    `surface epoch ${String(surfaceEpoch)}`,
  );
  addViolation(violations, toolCount !== toolNames.length, 'catalog name/count mismatch');
  addViolation(
    violations,
    toolCount < 0 || toolCount > MAX_TOOL_COUNT,
    'catalog tool count exceeds bounds',
  );
  addViolation(
    violations,
    sameNames(toolNames, listedToolNames) === false,
    'get_agent_catalog/listTools mismatch',
  );
  const missingRequiredTools = REQUIRED_MCP_TOOL_NAMES.filter(
    (requiredTool) => !toolNames.includes(requiredTool),
  );
  addViolation(
    violations,
    missingRequiredTools.length > 0,
    `missing required tools: ${missingRequiredTools.join(', ')}`,
  );
  addViolation(
    violations,
    mcp.mutationPosture !== 'read-only',
    'mutation posture is not read-only',
  );
  addViolation(
    violations,
    toolNames.includes('repair_apply_verify'),
    'mutation-only repair tool is registered',
  );
  addViolation(violations, project.scope !== 'project', 'project scope mismatch');
  addViolation(
    violations,
    canonicalProjectRoot !== canonicalWorkspaceRoot,
    'canonical project root mismatch',
  );
  addViolation(
    violations,
    serverVersion?.name !== EXPECTED_SERVER_NAME,
    'initialize server name mismatch',
  );
  addViolation(
    violations,
    serverVersion?.version !== version,
    'initialize/catalog version mismatch',
  );
  if (violations.length > 0) {
    throw new HarnessPrerequisiteError(
      `MCP surface verification failed: ${violations.join(', ')}. Rebuild and reconnect the MCP process.`,
    );
  }
  return {
    mutationPosture: 'read-only',
    projectRoot: canonicalProjectRoot,
    projectScope: 'project',
    surfaceEpoch,
    toolCount,
    toolNames,
    version,
  };
}
