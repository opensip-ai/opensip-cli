import { buildExternalWorkerChildEnv } from '../build-external-worker-child-env.js';

import type { CapabilityBridgeResourceDecision } from '@opensip-cli/core';

function allowedEnvNames(resourceDecision: CapabilityBridgeResourceDecision): readonly string[] {
  return resourceDecision.allowedResources
    .filter((requirement) => requirement.resource === 'env')
    .map((requirement) => requirement.scope)
    .filter((scope): scope is string => scope !== undefined && scope.length > 0);
}

export function buildCapabilityWorkerChildEnv(args: {
  readonly parentEnv?: NodeJS.ProcessEnv;
  readonly runId?: string;
  readonly traceparent?: string;
  readonly resourceDecision: CapabilityBridgeResourceDecision;
}): NodeJS.ProcessEnv {
  return buildExternalWorkerChildEnv({
    parentEnv: args.parentEnv,
    runId: args.runId,
    traceparent: args.traceparent,
    includePassthrough: false,
    extraAllowlist: allowedEnvNames(args.resourceDecision),
  });
}
