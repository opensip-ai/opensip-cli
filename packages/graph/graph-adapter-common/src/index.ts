/**
 * @opensip-tools/graph-adapter-common — shared scaffolding for the
 * tree-sitter graph language adapters (graph-go, graph-java,
 * graph-python, graph-rust).
 *
 * This is a *helper layer for implementing* the engine's
 * `GraphLanguageAdapter` contract, not a change to it. It sits downstream
 * of `@opensip-tools/graph` (the engine) and upstream of the four
 * tree-sitter adapters:
 *
 *   core → … → graph (engine) → graph-adapter-common → graph-{go,java,python,rust}
 *
 * It exports `createX` factories that return values; the adapter composes
 * them. It exports NO `adapter` / `metadata` — it is a library, not a
 * discoverable graph adapter (its package.json deliberately omits
 * `opensipTools.kind`). `graph-typescript` (TS-compiler-backed, not
 * tree-sitter) shares none of this and must not depend on it.
 */

export {
  createDiscover,
  type TreeSitterDiscoverConfig,
} from './discover.js';

export {
  createTreeSitterParseProject,
  type TreeSitterParseConfig,
  type TreeSitterParsedFile,
  type TreeSitterParsedProject,
} from './parse.js';

export {
  hashConfig,
  makeConfigCacheKey,
} from './cache-key.js';

export { skipToEndOfLine, skipBlockComment } from './body-digest.js';

export { isReturnValueDiscarded } from './return-discarded.js';

export {
  record,
  makeFileClassifier,
  type FileClassifier,
  type FileClassifierConfig,
  runWalk,
  type RunWalkParams,
  synthesizeModuleInit,
  type SynthesizeModuleInitParams,
  buildNameIndex,
  nameOf,
} from './walk.js';
