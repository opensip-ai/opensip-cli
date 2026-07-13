/**
 * @fileoverview MCP result/graph tool handlers must REPLAY, never RE-RUN (ADR-0084).
 *
 * The MCP server (`@opensip-cli/mcp`) exposes the OpenSIP call graph + stored run
 * results to coding agents. Its tool handlers are read/replay-only: a result tool
 * (`get_latest_findings`, `show_run`, …) replays a persisted session through the
 * injected `ResultsReadPort`, and a graph tool reads the persisted catalog through
 * the injected `GraphReadPort`. A handler that imports a run-command ENTRY POINT
 * (`runFit` / `runGraph` / `runSim` / `runYagni`, a tool's `execute*` command
 * handler, or one of the graph-owned context producer services) re-executes the
 * underlying tool inline — the exact coupling ADR-0084 forbids: it bypasses the
 * replay contract, can spawn an unbounded build per agent query, and re-privileges
 * a tool runtime inside MCP.
 *
 * The single sanctioned re-run is `refresh_graph`, and it does NOT import a run
 * command: it goes through `GraphReadPort.refresh()`, whose rebuild thunk is wired
 * in the MCP COMPOSITION ROOT (`packages/mcp/src/command.ts`) — the one place
 * allowed to thread `runGraph`. This check is therefore path-gated to the MCP TOOL
 * handlers (`packages/mcp/src/tools/`) and the results read port; the composition
 * root is outside the gate by design.
 *
 * AST-based so a run-command symbol appearing as TEXT (a comment, a description
 * string) is ignored — only a real `import` of the entry point fires.
 */
// @fitness-ignore-file shipped-checks-must-be-generic -- AST-dependent dogfood check (ADR-0084): needs @opensip-cli/lang-typescript (getSharedSourceFile), which a project-local .mjs cannot import, and is path-gated to packages/mcp/. Same rationale as no-bootstrap-tool-import.
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/** MCP source subtrees this check guards: handlers plus result/context read ports. */
const GUARDED_PATHS: readonly string[] = [
  'packages/mcp/src/tools/',
  'packages/mcp/src/session-results-read-port',
  'packages/mcp/src/context-read-port',
  'packages/mcp/src/sqlite-context-read-port',
];

/**
 * Run-command ENTRY POINTS — importing any of these into an MCP tool handler is a
 * re-run (the replay contract violation). `run*` are the programmatic build
 * entries; `execute*` are the per-tool CLI command handlers.
 */
const RUN_COMMAND_SYMBOLS: ReadonlySet<string> = new Set([
  'runFit',
  'runGraph',
  'runSim',
  'runYagni',
  'executeFit',
  'executeGraph',
  'executeSimulation',
  'executeSim',
  'executeYagni',
  'produceContextInventory',
  'produceContextGraph',
  'produceContextTestSelection',
]);

function normalized(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Pure analysis over a parsed source file. Exported for unit tests. */
export function analyzeMcpResultsNoRerun(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return violations;

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const named = stmt.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      // The ORIGINAL imported name (`{ runGraph as build }` → `runGraph`).
      const imported = (element.propertyName ?? element.name).text;
      if (!RUN_COMMAND_SYMBOLS.has(imported)) continue;
      const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1;
      violations.push({
        filePath,
        line,
        message:
          `MCP read surface imports the mutation/producer entry point '${imported}' from ` +
          `'${stmt.moduleSpecifier.text}'. MCP tools are replay/read-only (ADR-0084): a result ` +
          `tool replays a persisted session through ResultsReadPort and a graph tool reads the ` +
          `catalog through GraphReadPort — never re-running the underlying tool inline.`,
        severity: 'error',
        suggestion:
          `Read through the injected port instead (ResultsReadPort.latestFindings / showRun, or ` +
          `GraphReadPort). The one sanctioned re-run is refresh_graph via GraphReadPort.refresh(), ` +
          `whose rebuild thunk is wired in the MCP composition root (command.ts) — not in a tool handler.`,
      });
    }
  }
  return violations;
}

export const mcpResultsNoRerun = defineCheck({
  id: 'b6f0c3d2-7a14-4e8b-9c25-3f1d6a0e7b84',
  slug: 'mcp-results-no-rerun',
  contentFilter: 'raw',
  description:
    'MCP handlers and read ports must replay/read through injected ports — never import run-command or context-producer entry points to re-run work (ADR-0084)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  analyze: (content, filePath) => {
    const path = normalized(filePath);
    if (isTestFile(path)) return [];
    if (!GUARDED_PATHS.some((guarded) => path.includes(guarded))) return [];
    return analyzeMcpResultsNoRerun(content, path);
  },
});
