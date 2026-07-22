import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  isReservedSuiteName,
  RESERVED_SUITE_NAMES,
  suitesConfigSchema,
} from '../document/suites.js';

const VALID_STEP = {
  tool: '00000000-0000-4000-8000-000000000001',
  command: 'fitness',
} as const;

describe('reserved suite names (ADR-0159)', () => {
  it.each(RESERVED_SUITE_NAMES)(
    "rejects a configured suite using the reserved built-in name '%s'",
    (name) => {
      const result = suitesConfigSchema.safeParse({
        [name]: { steps: [VALID_STEP] },
      });
      expect(result.success).toBe(false);
      const issue = result.success ? undefined : result.error.issues[0];
      expect(issue?.path).toEqual([name]);
      expect(issue?.message).toContain(`Suite name '${name}' is reserved`);
      expect(issue?.message).toContain(`opensip suite run ${name}-custom`);
    },
  );

  it('rejects a reserved name even alongside valid suites', () => {
    const result = suitesConfigSchema.safeParse({
      'my-review': { steps: [VALID_STEP] },
      audit: { steps: [VALID_STEP] },
    });
    expect(result.success).toBe(false);
  });

  it('accepts non-reserved suite names', () => {
    const result = suitesConfigSchema.safeParse({
      'audit-custom': { steps: [VALID_STEP] },
      'agent-context-custom': { steps: [VALID_STEP] },
      'my-review': { steps: [VALID_STEP] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a prototype-magic name instead of silently dropping the suite', () => {
    const document = parseYaml(`
__proto__:
  steps:
    - tool: ${VALID_STEP.tool}
      command: ${VALID_STEP.command}
`);
    expect(Object.prototype.hasOwnProperty.call(document, '__proto__')).toBe(true);
    expect(suitesConfigSchema.safeParse(document).success).toBe(false);
  });

  it('keeps the empty default', () => {
    expect(suitesConfigSchema.parse(undefined)).toEqual({});
  });

  it('exposes the reserved list and membership helper coherently', () => {
    expect(RESERVED_SUITE_NAMES).toEqual(['audit', 'agent-context']);
    for (const name of RESERVED_SUITE_NAMES) {
      expect(isReservedSuiteName(name)).toBe(true);
    }
    expect(isReservedSuiteName('audit-custom')).toBe(false);
  });
});
