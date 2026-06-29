import type { CommandSpec } from '@opensip-cli/core';

export function suiteStepOpts(
  spec: CommandSpec,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const opts: Record<string, unknown> = {};

  for (const option of spec.options ?? []) {
    const key = option.long.replace(/^--(?:no-)?/, '');
    const supplied = rawArgs[key];
    if (supplied !== undefined) {
      opts[key] = option.parse ? option.parse(String(supplied)) : supplied;
    } else if (option.arrayDefault !== undefined) {
      opts[key] = [...option.arrayDefault];
    } else if (option.default !== undefined) {
      opts[key] = option.default;
    }
  }

  return opts;
}
