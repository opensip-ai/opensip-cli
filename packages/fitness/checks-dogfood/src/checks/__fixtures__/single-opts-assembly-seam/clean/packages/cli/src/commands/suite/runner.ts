import { assembleOptsFromSpec } from '../../../../assemble-opts.js';

import type { CommandSpec } from '@opensip-cli/core';

export function suiteStepOpts(
  spec: CommandSpec,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  return assembleOptsFromSpec(spec, rawArgs, { source: `suite step ${spec.name}` });
}
