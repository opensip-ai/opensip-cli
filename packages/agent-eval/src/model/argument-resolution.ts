import type {
  AnswerFact,
  AnswerFactPattern,
  ArgumentTemplateValue,
  BindableFactField,
  FactBinding,
  FactObservation,
  JsonValue,
  ResolvedStrategyStep,
  StrategyStep,
} from './task.js';

/** Structured reason a declarative step argument could not be resolved. */
export interface ArgumentResolutionFailure {
  readonly code:
    | 'ambiguous-binding'
    | 'binding-limit'
    | 'invalid-field'
    | 'missing-binding'
    | 'observation-limit';
  readonly message: string;
  readonly path: string;
}

/** Success or bounded failure from resolving a strategy step's fact bindings. */
export type ArgumentResolutionResult =
  | { readonly failure: ArgumentResolutionFailure; readonly ok: false }
  | { readonly ok: true; readonly step: ResolvedStrategyStep };

export const MAX_ARGUMENT_BINDINGS = 32;
export const MAX_ARGUMENT_OBSERVATIONS = 10_000;

function boundedBindingLimit(requested: number): number {
  if (!Number.isFinite(requested)) return MAX_ARGUMENT_BINDINGS;
  return Math.max(0, Math.min(MAX_ARGUMENT_BINDINGS, Math.trunc(requested)));
}

function isFactBinding(value: ArgumentTemplateValue): value is FactBinding {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '$fact' in value;
}

function asUnknownRecord(value: object): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

/** Partial, kind-aware comparison shared by assertions and bindings. */
export function factMatches(pattern: AnswerFactPattern, fact: AnswerFact): boolean {
  if (pattern.kind !== fact.kind) return false;
  const actual = asUnknownRecord(fact);
  const stableFieldsMatch = Object.entries(pattern).every(
    ([key, expected]) =>
      key === 'kind' ||
      key === 'minimum' ||
      key === 'maximum' ||
      key === 'minimumConfidence' ||
      expected === actual[key],
  );
  if (!stableFieldsMatch) return false;
  if (pattern.kind === 'evidence' && fact.kind === 'evidence') {
    const rank = { high: 3, low: 1, medium: 2 } as const;
    const minimum = pattern.minimumConfidence;
    if (minimum !== undefined) {
      const actualConfidence = fact.confidence;
      if (
        actualConfidence !== 'high' &&
        actualConfidence !== 'medium' &&
        actualConfidence !== 'low'
      )
        return false;
      if (rank[actualConfidence] < rank[minimum]) return false;
    }
  }
  if (pattern.kind !== 'count' || fact.kind !== 'count') return true;
  return (
    (pattern.minimum === undefined || fact.value >= pattern.minimum) &&
    (pattern.maximum === undefined || fact.value <= pattern.maximum)
  );
}

function readFactField(fact: AnswerFact, field: BindableFactField): JsonValue | undefined {
  if (field in fact) {
    const value: unknown = fact[field as keyof AnswerFact];
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'string'
    ) {
      return value;
    }
  }
  return undefined;
}

function selectObservation(
  binding: FactBinding['$fact'],
  observations: readonly FactObservation[],
): {
  readonly fact?: AnswerFact;
  readonly failure?: ArgumentResolutionFailure;
} {
  const candidates = observations.filter(
    (observation) =>
      (binding.leg === undefined || binding.leg === observation.leg) &&
      (binding.stepId === undefined || binding.stepId === observation.stepId) &&
      factMatches(binding.match, observation.fact),
  );
  const select = binding.select ?? 'only';
  if (candidates.length === 0) {
    return {
      failure: {
        code: 'missing-binding',
        message: `No observed fact matched ${binding.match.kind}.`,
        path: '',
      },
    };
  }
  if (select === 'only' && candidates.length !== 1) {
    return {
      failure: {
        code: 'ambiguous-binding',
        message: `${candidates.length} observed facts matched ${binding.match.kind}.`,
        path: '',
      },
    };
  }
  const candidate = select === 'last' ? candidates.at(-1) : candidates[0];
  return { fact: candidate?.fact };
}

interface ResolutionContext {
  bindingCount: number;
  readonly maxBindings: number;
  readonly observations: readonly FactObservation[];
}

type ValueResolution =
  | { readonly failure: ArgumentResolutionFailure; readonly ok: false }
  | { readonly ok: true; readonly value: JsonValue };

function resolveBinding(
  template: FactBinding,
  path: string,
  context: ResolutionContext,
): ValueResolution {
  context.bindingCount += 1;
  if (context.bindingCount > context.maxBindings) {
    return {
      failure: {
        code: 'binding-limit',
        message: `A strategy step may resolve at most ${context.maxBindings} fact bindings.`,
        path,
      },
      ok: false,
    };
  }
  if (context.observations.length > MAX_ARGUMENT_OBSERVATIONS) {
    return {
      failure: {
        code: 'observation-limit',
        message: `A fact binding may inspect at most ${MAX_ARGUMENT_OBSERVATIONS} observations.`,
        path,
      },
      ok: false,
    };
  }
  const selected = selectObservation(template.$fact, context.observations);
  if (selected.failure !== undefined) {
    return { failure: { ...selected.failure, path }, ok: false };
  }
  const value = selected.fact && readFactField(selected.fact, template.$fact.field);
  if (value === undefined) {
    return {
      failure: {
        code: 'invalid-field',
        message: `Observed ${template.$fact.match.kind} fact has no ${template.$fact.field} field.`,
        path,
      },
      ok: false,
    };
  }
  return { ok: true, value };
}

interface PendingResolution {
  readonly assign: (value: JsonValue) => void;
  readonly path: string;
  readonly template: ArgumentTemplateValue;
}

function isArgumentArray(value: ArgumentTemplateValue): value is readonly ArgumentTemplateValue[] {
  return Array.isArray(value);
}

function isArgumentObject(
  value: ArgumentTemplateValue,
): value is Readonly<Record<string, ArgumentTemplateValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enqueueArray(
  current: PendingResolution,
  template: readonly ArgumentTemplateValue[],
  pending: PendingResolution[],
): void {
  const values = Array.from({ length: template.length }, (): JsonValue => null);
  current.assign(values);
  for (let index = template.length - 1; index >= 0; index -= 1) {
    const child = template[index];
    if (child === undefined) continue;
    pending.push({
      assign: (value) => {
        values[index] = value;
      },
      path: `${current.path}[${index}]`,
      template: child,
    });
  }
}

function enqueueObject(
  current: PendingResolution,
  template: Readonly<Record<string, ArgumentTemplateValue>>,
  pending: PendingResolution[],
): void {
  const value: Record<string, JsonValue> = {};
  current.assign(value);
  const entries = Object.entries(template);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const [key, child] = entry;
    pending.push({
      assign: (resolved) => {
        value[key] = resolved;
      },
      path: `${current.path}.${key}`,
      template: child,
    });
  }
}

function processPending(
  current: PendingResolution,
  context: ResolutionContext,
  pending: PendingResolution[],
): ArgumentResolutionFailure | undefined {
  if (isFactBinding(current.template)) {
    const resolved = resolveBinding(current.template, current.path, context);
    if (!resolved.ok) return resolved.failure;
    current.assign(resolved.value);
    return undefined;
  }
  if (isArgumentArray(current.template)) {
    enqueueArray(current, current.template, pending);
    return undefined;
  }
  if (isArgumentObject(current.template)) {
    enqueueObject(current, current.template, pending);
    return undefined;
  }
  current.assign(current.template);
  return undefined;
}

function resolveValue(
  template: ArgumentTemplateValue,
  path: string,
  context: ResolutionContext,
): ValueResolution {
  let root: JsonValue = null;
  const pending: PendingResolution[] = [
    {
      assign: (value) => {
        root = value;
      },
      path,
      template,
    },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const failure = processPending(current, context, pending);
    if (failure !== undefined) return { failure, ok: false };
  }
  return { ok: true, value: root };
}

/** Resolve a step from bounded, prior observations only. */
export function resolveStepArguments(
  step: StrategyStep,
  observations: readonly FactObservation[],
  maxBindings = MAX_ARGUMENT_BINDINGS,
): ArgumentResolutionResult {
  const context: ResolutionContext = {
    bindingCount: 0,
    maxBindings: boundedBindingLimit(maxBindings),
    observations,
  };
  const arguments_: Record<string, JsonValue> = {};
  for (const [key, template] of Object.entries(step.arguments)) {
    const resolved = resolveValue(template, `arguments.${key}`, context);
    if (!resolved.ok) return resolved;
    arguments_[key] = resolved.value;
  }
  return {
    ok: true,
    step: {
      ...step,
      arguments: arguments_,
      expectedNonEmpty: step.expectedNonEmpty ?? false,
    },
  };
}
