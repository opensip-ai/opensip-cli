import { describe, expect, it } from 'vitest';

import { analyzeFileForResultPatternConsistency } from '../result-pattern-consistency.js';

const analyze = analyzeFileForResultPatternConsistency;

describe('result-pattern-consistency — registration and invariant guards', () => {
  it('does not flag throws inside register() methods', () => {
    const content = [
      'class ValidationError extends Error {}',
      'class Registry {',
      '  register(item: { id: string; name: string }): void {',
      '    throw new ValidationError("duplicate")',
      '  }',
      '}',
    ].join('\n');
    expect(analyze(content, 'packages/core/src/lib/registry.ts')).toHaveLength(0);
  });

  it('does not flag fluent builder preconditions returning this', () => {
    const content = [
      'class ValidationError extends Error {}',
      'class Builder {',
      '  evaluateAssertions(): this {',
      '    throw new ValidationError("metrics required")',
      '    return this',
      '  }',
      '}',
    ].join('\n');
    expect(
      analyze(content, 'packages/simulation/engine/src/framework/result-builder.ts'),
    ).toHaveLength(0);
  });

  it('does not flag build() terminal preconditions', () => {
    const content = [
      'class ValidationError extends Error {}',
      'class Builder {',
      '  build(): object {',
      '    throw new ValidationError("metrics required")',
      '    return {}',
      '  }',
      '}',
    ].join('\n');
    expect(
      analyze(content, 'packages/simulation/engine/src/framework/result-builder.ts'),
    ).toHaveLength(0);
  });

  it('does not flag exhaustiveness throws after a never binding', () => {
    const content = [
      'class SystemError extends Error {}',
      'export function resolveSelector(arm: { type: string }) {',
      '  switch (arm.type) {',
      '    case "explicit": return []',
      '    default: {',
      '      const _exhaustive: never = arm',
      '      throw new SystemError("unknown")',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(analyze(content, 'packages/core/src/recipes/selector.ts')).toHaveLength(0);
  });

  it('does not flag loader infrastructure files', () => {
    const content = [
      'class ValidationError extends Error {}',
      'export function loadTargets(): void {',
      '  throw new ValidationError("bad config")',
      '}',
    ].join('\n');
    expect(analyze(content, 'packages/fitness/engine/src/targets/loader.ts')).toHaveLength(0);
  });

  it('does not flag recipe session service start() preconditions', () => {
    const content = [
      'class NotFoundError extends Error {}',
      'class SystemError extends Error {}',
      'class FitnessRecipeService {',
      '  async start(recipeOrName: string): Promise<object> {',
      '    throw new SystemError("in progress")',
      '    throw new NotFoundError("missing")',
      '    return {}',
      '  }',
      '}',
    ].join('\n');
    expect(analyze(content, 'packages/fitness/engine/src/recipes/service.ts')).toHaveLength(0);
  });

  it('still flags domain functions that throw expected errors without Result', () => {
    const content = [
      'class ValidationError extends Error {}',
      'export function applyName(name: string): string {',
      '  if (!name) throw new ValidationError("required")',
      '  return name',
      '}',
    ].join('\n');
    expect(analyze(content, 'src/services/user.ts').length).toBeGreaterThanOrEqual(1);
  });
});
