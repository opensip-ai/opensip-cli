// @fitness-ignore-file module-coupling-fan-out -- registration barrel: imports every graph MCP tool module to mount the public surface; fan-out is the registry's role.
/** Register graph catalog reads plus the explicit graph refresh operation. */

import { registerBlastRadius } from './blast-radius.js';
import { registerCalleesOf } from './callees-of.js';
import { registerFindDeadCode } from './find-dead-code.js';
import { registerGetArchitecture } from './get-architecture.js';
import { registerGetSymbol } from './get-symbol.js';
import { registerImpactFiles } from './impact-files.js';
import { registerPackageCycles } from './package-cycles.js';
import { registerPackageDependencies } from './package-dependencies.js';
import { registerReferencesTo } from './references-to.js';
import { registerRefreshGraph } from './refresh-graph.js';
import { registerSearchDeclarations } from './search-declarations.js';
import { registerSearchSymbols } from './search-symbols.js';
import { registerSelectTests } from './select-tests.js';
import { registerTracePath } from './trace-path.js';
import { registerWhoCalls } from './who-calls.js';
import { registerWhyDepends } from './why-depends.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerGraphTools(server: McpStdioServer, deps: McpToolDeps): void {
  registerSearchSymbols(server, deps);
  registerSearchDeclarations(server, deps);
  registerReferencesTo(server, deps);
  registerGetSymbol(server, deps);
  registerImpactFiles(server, deps);
  registerSelectTests(server, deps);
  registerWhoCalls(server, deps);
  registerCalleesOf(server, deps);
  registerTracePath(server, deps);
  registerBlastRadius(server, deps);
  registerFindDeadCode(server, deps);
  registerGetArchitecture(server, deps);
  registerPackageDependencies(server, deps);
  registerWhyDepends(server, deps);
  registerPackageCycles(server, deps);
  registerRefreshGraph(server, deps);
}
