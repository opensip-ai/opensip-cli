/**
 * Commander action callback helpers for the CommandSpec mount layer.
 */

/**
 * Best-effort guard: does `x` look like a Commander `Command` instance?
 * Used defensively in splitActionArgs so we never treat the Command object
 * as the parsed opts.
 */
function isLikelyCommanderCommand(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.name === 'function' ||
    typeof c.opts === 'function' ||
    typeof c.command === 'function' ||
    (typeof c.constructor === 'function' && /Command/i.test(c.constructor.name || ''))
  );
}

/**
 * Split a Commander action callback's variadic arguments into the parsed-opts
 * object and the trailing positional args.
 *
 * Commander calls `action((...positionalArgs, optsObject, command))`: the
 * declared positionals come first, then the parsed-options object, then the
 * `Command` instance.
 *
 * @throws {Error} When Commander does not provide a final Command argument, or
 * when argument splitting would select the Command object as parsed options.
 */
export function splitActionArgs(actionArgs: readonly unknown[]): {
  opts: Record<string, unknown>;
  positionals: readonly unknown[];
} {
  if (actionArgs.length === 0) {
    return { opts: {}, positionals: [] };
  }

  const lastIdx = actionArgs.length - 1;
  if (!isLikelyCommanderCommand(actionArgs[lastIdx])) {
    throw new Error(
      'mountCommandSpec: splitActionArgs could not locate Commander Command as the final action argument. ' +
        'This indicates an incompatible Commander version or a wrapped dispatch. ' +
        'Please report this with your Commander version.',
    );
  }

  for (let i = lastIdx - 1; i >= 0; i--) {
    const v = actionArgs[i];
    if (v && typeof v === 'object' && !Array.isArray(v) && !isLikelyCommanderCommand(v)) {
      const opts = v as Record<string, unknown>;
      const positionals = actionArgs.slice(0, i);

      if (isLikelyCommanderCommand(opts)) {
        throw new Error(
          'mountCommandSpec: splitActionArgs selected a Commander Command as the parsed opts. ' +
            'Refusing to dispatch — this is a bug in argument splitting.',
        );
      }
      return { opts, positionals };
    }
  }

  const positionals = actionArgs.slice(0, lastIdx);
  return { opts: {}, positionals };
}
