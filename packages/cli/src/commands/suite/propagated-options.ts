import { optionKey } from '../assemble-opts.js';

import type { ValidatedSuiteStep } from './validate-suite.js';

export const PROPAGATABLE_SUITE_OPTION_KEYS = ['changed', 'since', 'files'] as const;

type PropagatableSuiteOptionKey = (typeof PROPAGATABLE_SUITE_OPTION_KEYS)[number];

export interface PropagatedSuiteArgsInput {
  readonly step: ValidatedSuiteStep;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly defaultChanged?: boolean;
}

function hasSelector(input: Readonly<Record<string, unknown>>): boolean {
  return (
    input.changed === true ||
    (typeof input.since === 'string' && input.since !== '') ||
    (Array.isArray(input.files) && input.files.length > 0)
  );
}

function selectedValue(
  key: PropagatableSuiteOptionKey,
  suiteOpts: Readonly<Record<string, unknown>>,
  defaultChanged: boolean,
): unknown {
  if (key === 'changed') {
    if (suiteOpts.changed === true) return true;
    return defaultChanged && !hasSelector(suiteOpts) ? true : undefined;
  }
  if (key === 'since') {
    return typeof suiteOpts.since === 'string' && suiteOpts.since !== ''
      ? suiteOpts.since
      : undefined;
  }
  if (key === 'files') {
    return Array.isArray(suiteOpts.files) && suiteOpts.files.length > 0
      ? suiteOpts.files
      : undefined;
  }
}

export function declaredOptionKeys(step: ValidatedSuiteStep): ReadonlySet<string> {
  return new Set((step.spec.options ?? []).map(optionKey));
}

export function propagatedSuiteArgs(input: PropagatedSuiteArgsInput): Record<string, unknown> {
  const declared = declaredOptionKeys(input.step);
  const propagated: Record<string, unknown> = {};
  for (const key of PROPAGATABLE_SUITE_OPTION_KEYS) {
    if (!declared.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(input.step.args, key)) continue;
    const value = selectedValue(key, input.suiteOpts, input.defaultChanged === true);
    if (value !== undefined) propagated[key] = value;
  }
  return propagated;
}
