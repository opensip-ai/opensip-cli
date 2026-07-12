/**
 * Shared registration context for the MCP tools (ADR-0084).
 *
 * Each tool file exports a `register<Name>(server, deps)` function; the host
 * passes the SAME pre-built ports the server captured plus the live set of
 * registered tool ids (for the result tools' `tool`-argument validation). Tools
 * read ONLY their injected port — never `currentScope()`, never a run-command
 * entry point (the `mcp-results-no-rerun` invariant).
 */

import type { GraphReadPort } from '../graph-read-port.js';
import type { RepairWritePort } from '../repair-write-port.js';
import type { ResultsReadPort } from '../results-read-port.js';
import type { RuntimeWiringReadPort } from '../runtime-wiring-read-port.js';
import type { McpSurfaceSnapshot } from '../server.js';
import type { TargetConventionSummary } from '@opensip-cli/contracts';

export interface McpToolDeps {
  /** Pre-built graph read port (graph tools). */
  readonly graph: GraphReadPort;
  /** Pre-built results/history read port (result tools). */
  readonly results: ResultsReadPort;
  /** Live declarative tool/manifest/CommandSpec wiring (not static graph). */
  readonly runtimeWiring: RuntimeWiringReadPort;
  /** The live registered tool ids — `get_latest_findings`/`show_run` validate `tool` against these. */
  readonly validToolIds: ReadonlySet<string>;
  /** Bounded target convention summaries captured from the served project scope. */
  readonly targetConventions?: readonly TargetConventionSummary[];
  /** Optional mutating repair port. Undefined keeps the MCP server read-only. */
  readonly repairWrite?: RepairWritePort;
  /** True only when the server was started with explicit mutation posture. */
  readonly mutationsEnabled?: boolean;
  /**
   * Final MCP surface snapshot after all registrations. Used by
   * `get_agent_catalog` for connector diagnosis (version/epoch/names/root).
   */
  readonly mcpSurface?: () => McpSurfaceSnapshot;
}
