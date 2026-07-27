/**
 * `@opensip-cli/graph` error definitions (Plan 01).
 *
 * `graph` IS a Tool, so this catalog is keyed on its stable tool UUID rather than the package
 * name — the ruling D1 package-name rule governs SUBSTRATE catalogs, and using a package name
 * here would give one owner two identities.
 *
 * Before registration the `GRAPH` head was mapped by nothing, so every literal resolved to
 * `CORE.SYSTEM.UNKNOWN_FAILURE` — severity fatal, exposure operator-only. That is a poor fit
 * for this surface: a cursor a caller mis-typed, a catalog that changed under a build, and a
 * timed-out child all need distinct recovery posture.
 */

import { defineErrorCatalog } from '@opensip-cli/core';

// Imported, not restated: the owner id must be the SAME value the tool registers under, and a
// second copy of a UUID is a divergence waiting to happen.
import { GRAPH_STABLE_ID } from '../identity.js';

import type { ErrorDefinition } from '@opensip-cli/core';

/**
 * `publicPresentationKey` on three definitions below is the ruling `result-reason-code-scope`
 * binding: the same condition is reachable BOTH as a thrown, catalogued error and as a
 * `GraphReadReason` on the non-throwing `@opensip-cli/graph/read` boundary. The key names the
 * reason its definition corresponds to, so the two spellings are linked in one declared place
 * instead of by a reader noticing they look similar.
 *
 * The link is declared on the definition, not on the reason, because the definition is the side
 * that has axes to declare. `GraphReadError` stays a plain-data DTO (ADR-0147).
 */

const TOOL_AUTHOR_RESPONSIBILITY = 'tool-author' as const;

/** A caller's read request is unusable. Nothing is wrong with the catalog. */
const READ_REQUEST = {
  source: 'application',
  defaultResponsibility: TOOL_AUTHOR_RESPONSIBILITY,
  kind: 'validation',
  retry: 'never',
  severity: 'error',
  exposure: 'public',
  exitClass: 'runtime',
  stability: 'public',
  lifecycle: 'active',
} as const satisfies Omit<ErrorDefinition, 'owner' | 'code' | 'operatorAction'>;

const CALLER_POLICY_RETRY = 'caller-policy' as const;

export const graphErrorCatalog = defineErrorCatalog(
  {
    id: GRAPH_STABLE_ID,
    displayName: 'graph',
    packageName: '@opensip-cli/graph',
  },
  {
    /**
     * A pagination cursor is not one this view issued.
     *
     * Kept SEPARATE from the other read failures even though the axes match, because MCP
     * consumers branch on it: an invalid cursor means "start the page sequence again", which is
     * a different recovery from "your query was wrong". That is the D9 exception — distinct
     * codes where a consumer genuinely branches.
     */
    'GRAPH.READ.CURSOR_INVALID': {
      ...READ_REQUEST,
      code: 'GRAPH.READ.CURSOR_INVALID',
      publicPresentationKey: 'cursor-invalid',
      operatorAction:
        'Restart the page sequence without a cursor; cursors are only valid for the catalog generation that issued them.',
      publicMetadataKeys: ['view'],
    },

    /**
     * A read query is unusable: an unsupported filter, a bound outside its range, or a source
     * role the config does not define.
     *
     * One code across the views (D9) — the caller fixes its request the same way in each, and
     * `metadata.view` plus `metadata.field` say where.
     */
    'GRAPH.READ.QUERY_INVALID': {
      ...READ_REQUEST,
      code: 'GRAPH.READ.QUERY_INVALID',
      publicPresentationKey: 'query-invalid',
      operatorAction:
        'Correct the named query field; the message states the supported values or bound for it.',
      publicMetadataKeys: ['view', 'field', 'condition'],
    },

    /**
     * An external dependency or persistence operation failed while serving a graph read.
     *
     * One environment/I/O family covers each read surface (D9); the boundary condition names
     * the operation, while an already-defined cause remains primary in operator evidence.
     */
    'GRAPH.READ.INFRASTRUCTURE_FAILED': {
      code: 'GRAPH.READ.INFRASTRUCTURE_FAILED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: CALLER_POLICY_RETRY,
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Inspect the read condition and local failure detail, restore the failing dependency, then retry.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /**
     * An otherwise valid graph generation could not be projected into one public read view.
     *
     * The read condition identifies the view (D9). This boundary never replaces a definition
     * already carried by the cause.
     */
    'GRAPH.READ.PROJECTION_FAILED': {
      code: 'GRAPH.READ.PROJECTION_FAILED',
      source: 'application',
      defaultResponsibility: TOOL_AUTHOR_RESPONSIBILITY,
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Capture the read condition and run id, then report the graph projection failure to the tool author.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /**
     * The stored catalog cannot be read, or could not be verified against the sources it
     * describes.
     *
     * `integrity` and `environment`: the caller did nothing wrong, and the recovery is to
     * rebuild rather than to change the request. `caller-policy` retry because a rebuild is
     * exactly the retry that fixes it.
     */
    'GRAPH.CATALOG.UNREADABLE': {
      code: 'GRAPH.CATALOG.UNREADABLE',
      publicPresentationKey: 'catalog-unreadable',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'integrity',
      retry: CALLER_POLICY_RETRY,
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction: 'Run `opensip graph` to rebuild the catalog, then retry the read.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /** A graph context producer was invoked without the datastore its RunScope must provide. */
    'GRAPH.CONTEXT_CATALOG.DATASTORE_REQUIRED': {
      code: 'GRAPH.CONTEXT_CATALOG.DATASTORE_REQUIRED',
      publicPresentationKey: 'context-catalog-datastore-required',
      source: 'application',
      defaultResponsibility: TOOL_AUTHOR_RESPONSIBILITY,
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Enter a project RunScope with its datastore before invoking graph context producers.',
      stability: 'public',
      lifecycle: 'active',
    },

    /**
     * A scoped graph-context catalog operation failed after the boundary was entered.
     *
     * One environment/I/O definition covers datastore resolution and each repository operation
     * (D9). The closed Result reasons remain operation-specific plain data; `metadata.condition`
     * identifies the failed step in operator evidence without creating three equivalent codes.
     */
    'GRAPH.CONTEXT_CATALOG.OPERATION_FAILED': {
      code: 'GRAPH.CONTEXT_CATALOG.OPERATION_FAILED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: CALLER_POLICY_RETRY,
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Inspect the operation condition and local datastore failure detail, restore storage availability, then retry.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /** A persisted context snapshot no longer proves the immutable identity recorded for it. */
    'GRAPH.CONTEXT_SNAPSHOT.PAYLOAD_MALFORMED': {
      code: 'GRAPH.CONTEXT_SNAPSHOT.PAYLOAD_MALFORMED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'integrity',
      retry: CALLER_POLICY_RETRY,
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Discard the malformed context snapshot and re-run its producing graph context command.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /**
     * A build could not produce a complete catalog: sources changed underneath it, or shards
     * failed.
     *
     * `warning` severity and a `success` exit class per ruling D7. The build reports reduced
     * coverage through its own freshness facets, and failing the command outright would
     * destroy a partial catalog that is still useful — and that the coverage fields already
     * describe honestly.
     */
    'GRAPH.BUILD.INCOMPLETE': {
      code: 'GRAPH.BUILD.INCOMPLETE',
      source: 'application',
      defaultResponsibility: 'environment',
      kind: 'conflict',
      retry: 'transient',
      severity: 'warning',
      exposure: 'public',
      exitClass: 'success',
      operatorAction:
        'The graph build did not cover every source. Re-run `opensip graph` when the working tree is settled; the coverage fields report what was missed.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'errorCode', 'shard'],
    },

    /**
     * A usable catalog was produced, but one or more known inputs are absent.
     *
     * This is ruling D7's degradation case, not a runtime fault: the structured
     * marker remains in the SignalEnvelope on every output surface, and the
     * existing `failOnDegraded` policy decides whether it fails the run. One
     * definition covers each coverage source (D9); `metadata.condition` names
     * the source and `metadata.count` quantifies it.
     */
    'GRAPH.CATALOG.PARTIAL_COVERAGE': {
      code: 'GRAPH.CATALOG.PARTIAL_COVERAGE',
      source: 'application',
      defaultResponsibility: 'environment',
      kind: 'integrity',
      retry: CALLER_POLICY_RETRY,
      severity: 'warning',
      exposure: 'public',
      exitClass: 'success',
      operatorAction:
        'Inspect the coverage condition, fix or exclude the omitted inputs, then rebuild the graph.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'count'],
    },

    /**
     * A language adapter could not enumerate the source tree for reasons that do not already
     * have a Core native-error classification.
     *
     * Permission and resource exhaustion retain their existing Core definitions (D6). This
     * definition is the adapter boundary for remaining filesystem failures such as a malformed
     * link traversal. One code covers every graph language (D9); metadata identifies the
     * language and discovery step without exposing the affected absolute path.
     */
    'GRAPH.ADAPTER.DISCOVERY_FAILED': {
      code: 'GRAPH.ADAPTER.DISCOVERY_FAILED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: CALLER_POLICY_RETRY,
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction:
        'Inspect the discovery condition and OS errno, repair the source-tree filesystem problem, then retry the graph build.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'errno', 'language'],
    },

    /** A requested TypeScript configuration anchor does not exist. */
    'GRAPH.TSCONFIG.NOT_FOUND': {
      code: 'GRAPH.TSCONFIG.NOT_FOUND',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction:
        'Create the requested tsconfig.json or correct the configured TypeScript project path.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /** A TypeScript configuration was readable but structurally invalid. */
    'GRAPH.TSCONFIG.INVALID': {
      code: 'GRAPH.TSCONFIG.INVALID',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction:
        'Correct the reported TypeScript configuration diagnostic, then retry the graph build.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'diagnosticCode'],
    },

    /** TypeScript configuration loading failed for an environmental I/O reason. */
    'GRAPH.TSCONFIG.LOAD_FAILED': {
      code: 'GRAPH.TSCONFIG.LOAD_FAILED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: CALLER_POLICY_RETRY,
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction:
        'Inspect the configuration-load condition and OS errno, restore file access, then retry the graph build.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'diagnosticCode', 'errno'],
    },

    /** The graph project root does not exist. */
    'GRAPH.PROJECT_DIR.NOT_FOUND': {
      code: 'GRAPH.PROJECT_DIR.NOT_FOUND',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction: 'Correct the graph project root or create the requested directory.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /** The graph project root resolves to a non-directory filesystem entry. */
    'GRAPH.PROJECT_DIR.NOT_A_DIRECTORY': {
      code: 'GRAPH.PROJECT_DIR.NOT_A_DIRECTORY',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction: 'Choose a directory as the graph project root, then retry.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition'],
    },

    /** The project root could not be inspected or canonicalized for an unclassified I/O reason. */
    'GRAPH.PROJECT_DIR.INSPECTION_FAILED': {
      code: 'GRAPH.PROJECT_DIR.INSPECTION_FAILED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: CALLER_POLICY_RETRY,
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction:
        'Inspect the project-root condition and OS errno, restore filesystem access, then retry.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'errno'],
    },

    /** A TypeScript adapter record lost coordinates required by occurrence-identity stitching. */
    'GRAPH.TS.OWNER_POSITION_MISSING': {
      code: 'GRAPH.TS.OWNER_POSITION_MISSING',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction:
        'Report the graph adapter invariant failure with the affected coordinate field.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['field'],
    },

    /** A TypeScript source file could not be read for a non-fatal graph parse. */
    'GRAPH.TS.SOURCE_UNREADABLE': {
      code: 'GRAPH.TS.SOURCE_UNREADABLE',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: CALLER_POLICY_RETRY,
      severity: 'warning',
      exposure: 'public',
      exitClass: 'success',
      operatorAction:
        'Restore access to the omitted TypeScript source or exclude it, then rebuild the graph.',
      stability: 'public',
      lifecycle: 'active',
    },

    /**
     * A shard-dependent operation has no trustworthy complete result.
     *
     * Ordinary graph runs do not throw this merely because one shard failed:
     * surviving fragments produce a D7 degradation marker. This hard boundary
     * is reserved for zero usable fragments and proof commands that explicitly
     * require complete evidence.
     */
    'GRAPH.SHARD.FAILURES': {
      code: 'GRAPH.SHARD.FAILURES',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'integrity',
      retry: CALLER_POLICY_RETRY,
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Inspect the named shard and its bounded stderr detail in the run log, then retry the graph build.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'count', 'errorCode', 'shard'],
    },

    /**
     * A workspace child process could not be created.
     *
     * Kept separate from timeout even though both fail one workspace unit: a spawn failure is
     * an OS I/O problem and carries an errno, while a timeout is a deadline with a different
     * retry decision. The non-throwing workspace result uses `spawn-failed` as its closed reason
     * token, linked here rather than replacing that DTO with a ToolError (ruling D4).
     */
    'GRAPH.WORKSPACE.CHILD_SPAWN_FAILED': {
      code: 'GRAPH.WORKSPACE.CHILD_SPAWN_FAILED',
      publicPresentationKey: 'spawn-failed',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: CALLER_POLICY_RETRY,
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction:
        'Check process limits, permissions, and the reported OS errno, then retry the workspace run.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'errno', 'unit'],
    },

    /** A workspace child exceeded its hard wall-clock deadline. */
    'GRAPH.WORKSPACE.CHILD_TIMEOUT': {
      code: 'GRAPH.WORKSPACE.CHILD_TIMEOUT',
      publicPresentationKey: 'timeout',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'timeout',
      retry: CALLER_POLICY_RETRY,
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Reduce the workspace unit workload or raise the child deadline, then retry the run.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'timeoutMs', 'unit'],
    },

    /**
     * A successful child exit did not carry a valid SignalEnvelope.
     *
     * This is a hard run fault under ruling D7: treating corrupt or absent output as an empty
     * signal list would make a whole workspace unit false-green.
     */
    'GRAPH.WORKSPACE.CHILD_OUTPUT_MALFORMED': {
      code: 'GRAPH.WORKSPACE.CHILD_OUTPUT_MALFORMED',
      publicPresentationKey: 'output-malformed',
      source: 'application',
      defaultResponsibility: TOOL_AUTHOR_RESPONSIBILITY,
      kind: 'integrity',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Ensure the parent and child use the same opensip-cli build, then report the malformed child envelope if it recurs.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'unit'],
    },

    /**
     * One contributed graph rule threw while evaluating an otherwise usable catalog.
     *
     * The shared rule boundary isolates the bad rule and emits a high-severity signal, so
     * evidence from rules before and after it survives while the run still fails visibly. One
     * code covers every rule (D9); `metadata.rule` identifies the contribution. An existing
     * definition-backed cause remains the primary cause code rather than being downgraded.
     */
    'GRAPH.RULE.EVALUATION_FAILED': {
      code: 'GRAPH.RULE.EVALUATION_FAILED',
      source: 'application',
      defaultResponsibility: TOOL_AUTHOR_RESPONSIBILITY,
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction:
        'Disable or fix the named graph rule, then re-run; other rules completed and their evidence was retained.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['condition', 'rule', 'causeCode'],
    },
  },
);
