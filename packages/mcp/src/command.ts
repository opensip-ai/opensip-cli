/**
 * The `opensip mcp` command (ADR-0084 + MCP Graph Audit).
 *
 * Captures the entered `RunScope` once, constructs graph/results ports from
 * public graph/read functions + captured adapters, and never calls
 * `currentScope()` from handlers or ports.
 */
import { realpathSync } from 'node:fs';

import { RESERVED_SUITE_NAMES } from '@opensip-cli/config';
import {
  assembleAgentCatalog,
  EXIT_CODES,
  hostSupportFromRuntimeProjection,
  projectAgentCatalogRuntimeFacts,
  summarizeTargetConventions,
  type FileEvidenceSupport,
} from '@opensip-cli/contracts';
import {
  definePrimaryCommand,
  EnvRegistry,
  err,
  logger,
  PLATFORM_SUPPORT_CONTRACT_VERSION,
  projectRuntimeHostSupport,
  readPackageVersion,
  type EnvVarSpec,
  type Result,
  type RunScope,
  type ToolCliContext,
} from '@opensip-cli/core';
import { loadGraphReadConfig, rebuildCatalog, type Catalog } from '@opensip-cli/graph/read';

import { capturedConfigIdentity } from './captured-config-identity.js';
import { LiveRuntimeWiringReadPort } from './live-runtime-wiring-read-port.js';
import { LocalCodebaseReadPort } from './local-codebase-read-port.js';
import { fromGraphReadError } from './mcp-error.js';
import { CliRepairWritePort } from './repair-write-port.js';
import { McpStdioServer } from './server.js';
import { SessionResultsReadPort } from './session-results-read-port.js';
import { SqliteContextReadPort } from './sqlite-context-read-port.js';
import { SqliteGraphReadPort } from './sqlite-graph-read-port.js';
import { MCP_SURFACE_EPOCH, registerMcpTools } from './tools/register.js';

import type { McpReadError } from './mcp-error.js';
import type { DataStore } from '@opensip-cli/datastore';

interface McpCommandOptions {
  readonly allowMutations?: boolean;
}

const MCP_MUTATION_ENV_SPECS: readonly EnvVarSpec<unknown>[] = [
  {
    canonical: 'OPENSIP_MCP_ALLOW_MUTATIONS',
    coerce: (raw) => raw === '1',
    default: false,
    docs: 'Set to 1 to enable explicitly mutating MCP tools such as repair_apply_verify when serving over stdio.',
  },
];

function mutationsEnabled(opts: McpCommandOptions): boolean {
  const env = new EnvRegistry(MCP_MUTATION_ENV_SPECS);
  return opts.allowMutations === true || env.get<boolean>('OPENSIP_MCP_ALLOW_MUTATIONS') === true;
}

/** Named serve entry for static-handler audit bridging. */
async function serveMcpStdio(rawOpts: unknown, cli: ToolCliContext): Promise<void> {
  const scope = cli.scope as RunScope;

  const store = cli.scope.datastore() as DataStore | undefined;
  if (store === undefined) {
    await cli.reportFailure({
      message: 'opensip mcp requires a project datastore, but none is available.',
      suggestion:
        'Run `opensip mcp` from inside an opensip-cli project (where `opensip init` has been run).',
      code: 'MCP.DATASTORE_UNAVAILABLE',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      log: { evt: 'mcp.server.datastore_unavailable', level: 'error' },
    });
    return;
  }

  // Keep persistence reads bound to the exact root captured by the host:
  // existing stored rows may predate canonical-root advertisement. Filesystem
  // and response-context seams use the physical root so every live MCP context
  // agrees without rebinding historical session rows.
  const projectRoot = scope.projectContext?.projectRoot ?? process.cwd();
  const canonicalProjectRoot = realpathSync(projectRoot);
  const configPath = scope.projectContext?.configPath ?? 'opensip-cli.config.yml';
  const canonicalConfigPath =
    scope.projectContext?.configPath === undefined
      ? configPath
      : realpathSync(scope.projectContext.configPath);
  const graphConfig = loadGraphReadConfig(projectRoot, configPath);
  // Capture graph adapters once from the entered scope — never currentScope().
  const graphScope = scope.graph;
  if (graphScope === undefined) {
    await cli.reportFailure({
      message: 'opensip mcp requires the graph tool scope (adapters registry).',
      suggestion: 'Ensure the graph tool is registered in the CLI bootstrap.',
      code: 'MCP.GRAPH_SCOPE_UNAVAILABLE',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      log: { evt: 'mcp.server.graph_scope_unavailable', level: 'error' },
    });
    return;
  }
  const adapters = graphScope.adapters;
  const languageEvidenceSupport = new Map<string, FileEvidenceSupport>(
    adapters.getAll().map((entry) => {
      const semantic = entry.id === 'typescript' ? 'supported' : 'unsupported';
      return [
        entry.id,
        {
          callable: 'supported',
          declaration: semantic,
          reference: semantic,
        },
      ];
    }),
  );

  async function rebuild(): Promise<Result<Catalog, McpReadError>> {
    const outcome = await rebuildCatalog({
      cwd: projectRoot,
      datastore: store,
    });
    if (!outcome.ok) {
      return err(fromGraphReadError(outcome.error));
    }
    return outcome;
  }

  const graph = new SqliteGraphReadPort({
    store,
    projectRoot,
    contextProjectRoot: canonicalProjectRoot,
    configPath: canonicalConfigPath,
    adapters,
    languageAdapters: scope.languages.list(),
    config: graphConfig,
    rebuild,
    log: (evt, fields) => {
      logger.info({ evt, module: 'mcp:graph', ...fields });
    },
  });
  // Compute the honest, process-only host-support projection ONCE at
  // construction from the same process facts and shared contracts mapper the
  // CLI uses, so get_agent_catalog is byte-identical to `agent-catalog --json`
  // (Plan 02 / Plan 03 parity). A long-lived server never re-observes this per
  // method. npm/filesystem/install-channel stay unobserved → never exact.
  const hostSupport = hostSupportFromRuntimeProjection(
    projectRuntimeHostSupport({
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
    }),
    PLATFORM_SUPPORT_CONTRACT_VERSION,
  );
  // Assemble the ONE common agent catalog here at the composition boundary
  // (Plan 03 transport parity). `serveMcpStdio` is the only scope-reading site:
  // it projects the reserved host roots + internal Tool commands from the
  // complete, immutable runtime inventory (adding Commander's implicit `help`),
  // reuses the SAME target-convention array computed once for registerMcpTools,
  // imports the config-owned reserved suite names, and folds in the Plan 02
  // hostSupport — then hands the finished catalog to the read port, which is a
  // pure conduit. This makes the MCP common body byte-identical to
  // `opensip agent-catalog --json` for the same admitted registry + project.
  const targetConventions = summarizeTargetConventions(scope.targets);
  const runtimeFacts = projectAgentCatalogRuntimeFacts(scope.runtimeCommands, ['help']);
  const agentCatalog = assembleAgentCatalog({
    tools: scope.tools,
    internalCommands: new Set(runtimeFacts.internalCommands),
    rootCommands: runtimeFacts.rootCommands,
    suiteNames: RESERVED_SUITE_NAMES,
    hostSupport,
    ...(targetConventions.length === 0 ? {} : { projectContext: { targetConventions } }),
  });
  const results = new SessionResultsReadPort({
    store,
    projectRoot,
    tools: scope.tools,
    agentCatalog,
  });
  const codebase = new LocalCodebaseReadPort({
    projectRoot,
    configIdentity: capturedConfigIdentity(scope.configDocument),
    languageEvidenceSupport,
    ...(scope.targets === undefined ? {} : { targets: scope.targets }),
    log: (event, fields) => {
      logger.info({ evt: event, module: 'mcp:codebase', ...fields });
    },
  });
  const context = new SqliteContextReadPort({
    store,
    projectRoot,
    graph,
    codebase,
    log: (event, fields) => {
      logger.info({ evt: event, module: 'mcp:context', ...fields });
    },
  });
  const runtimeWiring = new LiveRuntimeWiringReadPort({
    projectRoot: canonicalProjectRoot,
    configPath: canonicalConfigPath,
    tools: scope.tools,
    manifests: scope.toolManifests,
    provenance: scope.toolProvenance,
    runtimeCommands: scope.runtimeCommands,
    resolveStaticHandlers: async (runtimeSnapshotKey, refs) => {
      const outcome = await graph.resolveStaticHandlerDeclarations(runtimeSnapshotKey, refs);
      if (!outcome.ok) {
        return {
          catalogStatus: 'missing' as const,
          outcomes: refs.map((ref) => ({
            ref,
            status: 'catalog-missing' as const,
            claimProvenance: 'author-declared' as const,
            matchBasis: 'author-declared-exact-declaration' as const,
            confidence: 'low' as const,
          })),
        };
      }
      return outcome.value;
    },
  });
  const mutationEnabled = mutationsEnabled(rawOpts as McpCommandOptions);
  const repairWrite = mutationEnabled
    ? new CliRepairWritePort({
        projectRoot,
      })
    : undefined;

  const server = new McpStdioServer({
    scope,
    graph,
    results,
    version: readPackageVersion(import.meta.url),
    projectRoot: canonicalProjectRoot,
    surfaceEpoch: MCP_SURFACE_EPOCH,
    mutationsEnabled: mutationEnabled,
  });

  const validToolIds = new Set(
    scope.tools.list().map((t) => t.identity.layoutKey ?? t.identity.name),
  );
  // `targetConventions` is computed once above (shared with the agent-catalog
  // assembly) — no second resolver read or alternate summarizer here.
  // Registration is synchronous; the Promise-shaped registerMcpTools return is
  // not a detached async job — fire-and-forget without awaiting is intentional.
  void registerMcpTools(server, {
    graph,
    codebase,
    context,
    results,
    runtimeWiring,
    validToolIds,
    targetConventions,
    ...(repairWrite === undefined ? {} : { repairWrite }),
    mutationsEnabled: mutationEnabled,
    // Surface snapshot is final after registration completes.
    mcpSurface: () => server.describeSurface(),
  });

  await server.serve();
  cli.setExitCode(EXIT_CODES.SUCCESS);
}

export const mcpCommandSpec = definePrimaryCommand<unknown, ToolCliContext>({
  staticHandler: {
    package: '@opensip-cli/mcp',
    path: 'packages/mcp/src/command.ts',
    declaration: 'serveMcpStdio',
  },
  description: 'Serve the OpenSIP call graph + stored results to MCP agents over stdio',
  commonFlags: ['cwd'],
  options: [
    {
      flag: '--allow-mutations',
      description: 'Enable explicitly mutating MCP tools such as repair_apply_verify',
      default: false,
    },
  ],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'mcp-stdio',
  handler: serveMcpStdio,
});
