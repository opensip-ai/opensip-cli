/**
 * Commander wiring helpers for declarative CommandSpec inputs.
 *
 * Kept out of mount-command-spec.ts so option/argument translation can evolve
 * independently from the host-owned command lifecycle.
 */

import { Option } from 'commander';

import { optionDefaultValue } from './assemble-opts.js';

import type { ArgSpec, OptionSpec } from '@opensip-cli/core';

export { optionKey } from './assemble-opts.js';

/**
 * Build a Commander {@link Option} from an {@link OptionSpec}, covering every
 * shape in the first-party flag corpus: boolean / value, negatable `--no-`,
 * literal `default` and repeatable `arrayDefault`, `choices`, the pure `parse`
 * argParser, variadic, and `required` (mandatory).
 *
 * @throws {Error} When the spec marks a boolean (valueless) option `required`
 *   — only value options can be made mandatory.
 */
export function buildOption(spec: OptionSpec, commandName: string): Option {
  const valuePlaceholder = resolveValuePlaceholder(spec);
  const flags = valuePlaceholder === undefined ? spec.flag : `${spec.flag} ${valuePlaceholder}`;
  const option = new Option(flags, spec.description);

  if (spec.choices !== undefined && spec.choices.length > 0) {
    option.choices([...spec.choices]);
  }
  if (spec.parse !== undefined) {
    // Commander's argParser is `(value, previous) => next` — exactly the
    // declared `OptionSpec.parse` reducer shape (Number coercion, repeatable
    // accumulation, validated ints).
    option.argParser(spec.parse);
  }
  // `arrayDefault` (repeatable accumulators) wins over a scalar `default`;
  // Commander uses it as the seed the `parse` reducer accumulates onto.
  const defaultValue = optionDefaultValue(spec);
  if (defaultValue !== undefined) {
    option.default(defaultValue);
  }
  if (spec.required === true) {
    if (valuePlaceholder === undefined) {
      throw new Error(
        `mountCommandSpec: command '${commandName}' option '${spec.flag}' is required but takes no value; ` +
          'only value options can be required.',
      );
    }
    option.makeOptionMandatory(true);
  }
  return option;
}

/**
 * Resolve the value placeholder for an option, applying variadic `...` when
 * declared. Returns `undefined` for a boolean / negatable flag (no value).
 */
function resolveValuePlaceholder(spec: OptionSpec): string | undefined {
  if (spec.negatable === true) return undefined;
  if (spec.value === undefined) return undefined;
  if (spec.variadic === true && !spec.value.includes('...')) {
    // Inject the variadic ellipsis inside the existing bracket pair, e.g.
    // `<slug>` -> `<slug...>`, `[path]` -> `[path...]`.
    return spec.value.replace(/([>\]])$/, '...$1');
  }
  return spec.value;
}

/**
 * Format an {@link ArgSpec} into Commander argument-usage syntax: `<name>`
 * (required), `[name]` (optional), with `...` appended for variadic.
 */
export function formatArgUsage(spec: ArgSpec): string {
  const inner = spec.variadic === true ? `${spec.name}...` : spec.name;
  return spec.optional === true ? `[${inner}]` : `<${inner}>`;
}
