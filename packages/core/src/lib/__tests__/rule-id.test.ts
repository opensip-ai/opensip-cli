import { describe, expect, it } from 'vitest';

import { namespacedRuleId } from '../rule-id.js';

describe('namespacedRuleId', () => {
  it('prefixes local rule slugs with the namespace', () => {
    expect(namespacedRuleId('yagni', 'unused-config-surface')).toBe('yagni:unused-config-surface');
  });

  it('is idempotent for already-prefixed slugs', () => {
    expect(namespacedRuleId('yagni', 'yagni:unused-config-surface')).toBe(
      'yagni:unused-config-surface',
    );
  });

  it('trims redundant colons from namespace and slug', () => {
    expect(namespacedRuleId('yagni::', '::unused-config-surface')).toBe(
      'yagni:unused-config-surface',
    );
  });

  it('returns the namespace unchanged when the slug equals the namespace', () => {
    expect(namespacedRuleId('yagni', 'yagni')).toBe('yagni');
  });
});
