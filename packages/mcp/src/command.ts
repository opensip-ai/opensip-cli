/**
 * The `opensip mcp` command (ADR-0084 + MCP Graph Audit).
 *
 * Captures the entered `RunScope` once, constructs graph/results ports from
 * public graph/read functions + captured adapters, and never calls
 * `currentScope()` from handlers or ports.
 */
import { EXIT_CODES, summarizeTargetConventions } from '@opensip-cli/contracts';
import {
  definePrimaryCommand,
  EnvRegistry,
  err,
  logger,
  readPackageVersion,
  type EnvVarSpec,
  type Result,
  type RunScope,
  type ToolCliContext,
} from '@opensip-cli/core';
import { loadGraphReadConfig, rebuildCatalog, type Catalog } from '@opensip-cli/graph/read';

import { LiveRuntimeWiringReadPort } from './live-runtime-wiring-read-port.js';
import { fromGraphReadError } from './mcp-error.js';
import { CliRepairWritePort } from './repair-write-port.js';
import { McpStdioServer } from './server.js';
import { SessionResultsReadPort } from './session-results-read-port.js';
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

  const projectRoot = scope.projectContext?.projectRoot ?? process.cwd();
  const configPath = scope.projectContext?.configPath ?? 'opensip-cli.config.yml';
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
    configPath,
    adapters,
    languageAdapters: scope.languages.list(),
    config: graphConfig,
    rebuild,
    log: (evt, fields) => {
      logger.info({ evt, module: 'mcp:graph', ...fields });
    },
  });
  const results = new SessionResultsReadPort({
    store,
    projectRoot,
    tools: scope.tools,
  });
  const runtimeWiring = new LiveRuntimeWiringReadPort({
    projectRoot,
    configPath,
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
    surfaceEpoch: MCP_SURFACE_EPOCH,
    mutationsEnabled: mutationEnabled,
  });

  const validToolIds = new Set(
    scope.tools.list().map((t) => t.identity.layoutKey ?? t.identity.name),
  );
  const targetConventions = summarizeTargetConventions(scope.targets);
  // Registration is synchronous; the Promise-shaped registerMcpTools return is
  // not a detached async job — fire-and-forget without awaiting is intentional.
  void registerMcpTools(server, {
    graph,
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
