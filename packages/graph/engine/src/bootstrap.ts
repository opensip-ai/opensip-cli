/**
 * Default-adapter bootstrap.
 *
 * Side-effect module: importing this file registers the first-party
 * GraphLanguageAdapters that still live inside the engine package
 * into the lang-adapter registry. Adapter packs that have moved into
 * their own packages (PR 1b: TypeScript) register through the CLI
 * bootstrap's `register-graph-adapters.ts` discovery walker instead.
 *
 * The graph tool's `tool.ts` and the orchestrator both import this so
 * the in-engine adapters are available whether the entry point is the
 * CLI command dispatcher or a direct `runGraph()` call from tests.
 *
 * As subsequent split PRs land (PR 2: python, PR 3: rust), each
 * `registerAdapter` line drains naturally. When the file is empty it
 * deletes; the discovery walker is then the single registration path.
 */

import { registerAdapter } from './lang-adapter/registry.js';
import { rustGraphAdapter } from './lang-rust/index.js';

registerAdapter(rustGraphAdapter);
