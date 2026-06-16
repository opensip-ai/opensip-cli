/**
 * register-tools — populate the kernel `ToolRegistry` with first-party
 * tools (fitness / simulation / graph) plus any third-party tool
 * packages discovered on disk.
 *
 * Extracted from `index.ts`. The bundled-id skip below is defense in
 * depth: as of Layer 1 Phase 1 the registry itself enforces
 * first-writer-wins on duplicate ids and logs a structured
 * `tool.registry.duplicate` warning. Keeping the explicit guard avoids
 * a noisy warning when a third-party package happens to ship under a
 * built-in id.
 */

export { BUNDLED_TOOL_PACKAGES, EXPECTED_SCAFFOLDING_TOOL_IDS } from './register-tools-shared.js';

export { registerFirstPartyTools } from './register-tools-bundled.js';

export {
  type DiscoveryOptions,
  buildToolDiscoverySources,
  discoverAndRegisterToolPackages,
  type AuthoredAdmission,
  admitProjectLocalTool,
  admitUserGlobalTool,
  discoverAndRegisterAuthoredTools,
} from './register-tools-discovery.js';

export { mountAllToolCommands } from './register-tools-mount.js';
