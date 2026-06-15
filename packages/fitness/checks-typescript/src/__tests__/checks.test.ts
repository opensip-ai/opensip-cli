import { describe, it, expect } from 'vitest';

import { checks } from '../index.js';

describe('checks-typescript', () => {
  it('exports a non-empty array of checks', () => {
    expect(checks.length).toBeGreaterThan(0);
  });

  it('all checks have required fields', () => {
    for (const check of checks) {
      expect(check.config.id).toBeDefined();
      expect(check.config.slug).toBeDefined();
      expect(check.config.description).toBeDefined();
      expect(check.config.tags).toBeDefined();
      expect(check.config.tags.length).toBeGreaterThan(0);
    }
  });

  it('all check slugs are unique', () => {
    const slugs = checks.map((c) => c.config.slug);
    const duplicates = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    expect(duplicates).toEqual([]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('all check IDs are unique', () => {
    const ids = checks.map((c) => c.config.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all checks have a valid analysisMode', () => {
    for (const check of checks) {
      expect(['analyze', 'analyzeAll', 'command']).toContain(check.config.analysisMode);
    }
  });

  it('all checks have a run function', () => {
    for (const check of checks) {
      expect(typeof check.run).toBe('function');
    }
  });
});
