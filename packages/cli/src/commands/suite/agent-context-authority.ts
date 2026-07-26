import { ConfigurationError, type ToolProvenance } from '@opensip-cli/core';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

import {
  BUILT_IN_AGENT_CONTEXT_PLANES,
  BUILT_IN_GRAPH_PACKAGE_NAME,
  BUILT_IN_GRAPH_TOOL_ID,
  BUILT_IN_GRAPH_TOOL_NAME,
} from './built-in-suites.js';

import type { ValidatedSuite } from './validate-suite.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const SUITE_INVALID = hostErrorCatalog.require('CONFIG.SUITE.INVALID');

const CONTEXT_COMMAND_SOURCE = 'packages/graph/engine/src/cli/context/context-command-specs.ts';

function invalid(message: string): never {
  throw new ConfigurationError(`Built-in agent-context authority check failed: ${message}`, {
    code: SUITE_INVALID.code,
    definition: SUITE_INVALID,
    metadata: { condition: 'context-authority' },
  });
}

function bundledGraphProvenance(
  provenance: readonly ToolProvenance[],
  expectedVersion: string,
): ToolProvenance {
  const exact = provenance.filter((record) => record.stableId === BUILT_IN_GRAPH_TOOL_ID);
  if (exact.length !== 1) {
    return invalid('exactly one admitted graph provenance record is required.');
  }
  const [record] = exact;
  if (
    record?.source !== 'bundled' ||
    record.id !== BUILT_IN_GRAPH_TOOL_NAME ||
    record.packageName !== BUILT_IN_GRAPH_PACKAGE_NAME ||
    record.version !== expectedVersion ||
    record.manifestHash.length === 0
  ) {
    return invalid('the graph tool provenance does not match the admitted bundled package.');
  }
  return record;
}

/**
 * Verify the complete trusted execution chain before the built-in context suite
 * runs. Missing provenance is deliberately not treated as implicitly bundled.
 */
export function validateBuiltInAgentContextAuthority(input: {
  readonly suite: ValidatedSuite;
  readonly provenance: readonly ToolProvenance[];
}): { readonly producerVersion: string } {
  if (input.suite.steps.length !== BUILT_IN_AGENT_CONTEXT_PLANES.length) {
    return invalid('the suite must contain the exact three host-defined context steps.');
  }

  let graphVersion: string | undefined;
  BUILT_IN_AGENT_CONTEXT_PLANES.forEach((expected, index) => {
    const step = input.suite.steps[index];
    if (
      step?.index !== index ||
      step.config.tool !== BUILT_IN_GRAPH_TOOL_ID ||
      step.config.name !== BUILT_IN_GRAPH_TOOL_NAME ||
      Object.keys(step.args).length > 0 ||
      step.positionals.length > 0 ||
      step.tool.metadata.id !== BUILT_IN_GRAPH_TOOL_ID ||
      step.tool.metadata.name !== BUILT_IN_GRAPH_TOOL_NAME ||
      step.tool.identity.name !== BUILT_IN_GRAPH_TOOL_NAME ||
      step.spec.name !== expected.command ||
      step.spec.visibility !== 'internal' ||
      step.kind !== 'evidence' ||
      step.spec.staticHandler?.package !== BUILT_IN_GRAPH_PACKAGE_NAME ||
      step.spec.staticHandler.path !== CONTEXT_COMMAND_SOURCE ||
      step.spec.staticHandler.declaration !== expected.declaration
    ) {
      invalid(`step ${String(index + 1)} is not the expected internal graph producer.`);
    }
    if (graphVersion !== undefined && graphVersion !== step.tool.metadata.version) {
      invalid('context steps resolved to inconsistent graph versions.');
    }
    graphVersion = step.tool.metadata.version;
  });

  if (graphVersion === undefined || graphVersion.length === 0) {
    return invalid('the graph producer version is unavailable.');
  }
  const provenance = bundledGraphProvenance(input.provenance, graphVersion);
  return { producerVersion: provenance.version };
}
