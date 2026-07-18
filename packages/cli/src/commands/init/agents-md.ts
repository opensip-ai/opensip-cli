/**
 * Back-compatible exports for the managed OpenSIP agent guidance writer.
 */
export {
  AGENT_GUIDANCE_END,
  AGENT_GUIDANCE_START,
  buildManagedAgentGuidance,
  ensureOpenSipAgentGuidance,
  listAgentGuidanceTargetSpecs,
  renderAgentGuidanceTargets,
  upsertManagedBlock,
} from './agent-guidance.js';
export type {
  AgentGuidanceReadFailure,
  AgentGuidanceTargetSnapshot,
  AgentGuidanceTargetSpec,
  RenderedAgentGuidance,
  RenderedAgentGuidanceTarget,
} from './agent-guidance.js';
