/**
 * Single orchestration vocabulary: maps lifecycle steps, pre-action phases, and
 * the implementing modules. Replaces parallel taxonomies in tool-lifecycle.ts
 * and pre-action-bootstrap-phases.ts as the one source of truth.
 */

import { PRE_ACTION_PHASES } from './pre-action-bootstrap-phases.js';
import { TOOL_LIFECYCLE_STEPS } from './tool-lifecycle.js';

/** One row in the orchestration map. */
export interface PhaseMapEntry {
  readonly lifecycleStep?: (typeof TOOL_LIFECYCLE_STEPS)[keyof typeof TOOL_LIFECYCLE_STEPS];
  readonly preActionPhase?: (typeof PRE_ACTION_PHASES)[keyof typeof PRE_ACTION_PHASES];
  readonly module: string;
  readonly symbol: string;
}

/**
 * Canonical phase map. Startup steps 1–4 live in `bootstrapCli`; step 8 in
 * `mountAllToolCommands`; steps 5–7 and 9 in the pre-action executor.
 */
export const BOOTSTRAP_PHASE_MAP: readonly PhaseMapEntry[] = [
  {
    lifecycleStep: TOOL_LIFECYCLE_STEPS.discover,
    module: 'bootstrap/index.ts',
    symbol: 'bootstrapCli → registerFirstPartyTools / discoverAndRegisterToolPackages',
  },
  {
    lifecycleStep: TOOL_LIFECYCLE_STEPS.compat,
    module: 'bootstrap/admit-tool-package.ts',
    symbol: 'admitToolPackage',
  },
  {
    lifecycleStep: TOOL_LIFECYCLE_STEPS.trust,
    module: 'bootstrap/authored-tool-admission.ts',
    symbol: 'admitProjectLocalTool',
  },
  {
    lifecycleStep: TOOL_LIFECYCLE_STEPS.import,
    module: 'bootstrap/validate-tool.ts',
    symbol: 'isValidTool + ToolRegistry.register',
  },
  {
    lifecycleStep: TOOL_LIFECYCLE_STEPS.config,
    preActionPhase: PRE_ACTION_PHASES.buildScope,
    module: 'bootstrap/config-and-capabilities.ts',
    symbol: 'composeAndValidateToolConfig',
  },
  {
    lifecycleStep: TOOL_LIFECYCLE_STEPS.scope,
    preActionPhase: PRE_ACTION_PHASES.buildScope,
    module: 'bootstrap/build-per-run-scope.ts',
    symbol: 'buildPerRunScope → resolveToolHooks().contributeScope',
  },
  {
    lifecycleStep: TOOL_LIFECYCLE_STEPS.capabilities,
    preActionPhase: PRE_ACTION_PHASES.toolPreflight,
    module: 'bootstrap/config-and-capabilities.ts',
    symbol: 'wireCapabilityRegistry + loadOwningToolCapabilities',
  },
  {
    lifecycleStep: TOOL_LIFECYCLE_STEPS.mount,
    module: 'bootstrap/register-tools-mount.ts',
    symbol: 'mountAllToolCommands',
  },
  {
    lifecycleStep: TOOL_LIFECYCLE_STEPS.initialize,
    preActionPhase: PRE_ACTION_PHASES.toolPreflight,
    module: 'bootstrap/owning-tool-init.ts',
    symbol: 'maybeInitializeOwningTool',
  },
  {
    lifecycleStep: TOOL_LIFECYCLE_STEPS.dispatch,
    module: 'commands/mount-command-spec.ts',
    symbol: 'mountCommandSpec action',
  },
  {
    preActionPhase: PRE_ACTION_PHASES.readCommandOptions,
    module: 'bootstrap/plan-pre-action-bootstrap.ts',
    symbol: 'planPreActionBootstrap',
  },
  {
    preActionPhase: PRE_ACTION_PHASES.bailoutWindow,
    module: 'bootstrap/pre-action-guards.ts',
    symbol: 'pre-action guards',
  },
  {
    preActionPhase: PRE_ACTION_PHASES.enterScope,
    module: 'bootstrap/execute-post-bailout-bootstrap.ts',
    symbol: 'enterScope',
  },
  {
    preActionPhase: PRE_ACTION_PHASES.dispose,
    module: 'bootstrap/pre-action-hook.ts',
    symbol: 'disposeCurrentScope',
  },
] as const;