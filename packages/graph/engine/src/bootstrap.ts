/**
 * Default-adapter bootstrap.
 *
 * Side-effect module: importing this file registers every first-party
 * GraphLanguageAdapter into the lang-adapter registry. The graph
 * tool's `tool.ts` and the orchestrator both import this so the
 * adapter is available whether the entry point is the CLI command
 * dispatcher or a direct `runGraph()` call from tests.
 *
 * Future first-party adapters (Python, Rust, etc.) get one
 * `registerAdapter` line here; third-party adapters register from
 * their own packages' tool.ts at install time.
 *
 * This is the single file outside `lang-typescript/` that's allowed
 * to import from `lang-typescript/` directly. The dep-cruiser rule
 * `graph-orchestrate-no-direct-lang-import` permits exactly this
 * file (and tool.ts via a separate allowance) so the layering stays
 * intact otherwise.
 */

import { registerAdapter } from './lang-adapter/registry.js';
import { pythonGraphAdapter } from './lang-python/index.js';
import { typescriptGraphAdapter } from './lang-typescript/index.js';

registerAdapter(typescriptGraphAdapter);
registerAdapter(pythonGraphAdapter);
