/**
 * Rule registry conformance test (PR-1, PR-16).
 *
 * Asserts every entry in `rules` has a non-empty graph: slug, valid
 * defaultSeverity, and a callable evaluate function.
 */

import { describe, expect, it } from 'vitest';

import { rules } from '../../rules/registry.js';

describe('rules registry conformance', () => {
  it('registry is non-empty', () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  it('every rule has a graph: slug', () => {
    for (const r of rules) {
      expect(r.slug.startsWith('graph:')).toBe(true);
      expect(r.slug.length).toBeGreaterThan('graph:'.length);
    }
  });

  it('every rule has a valid defaultSeverity', () => {
    for (const r of rules) {
      expect(['error', 'warning']).toContain(r.defaultSeverity);
    }
  });

  it('every rule has a callable evaluate', () => {
    for (const r of rules) {
      expect(typeof r.evaluate).toBe('function');
    }
  });

  it('all five v0.2 rules are registered', () => {
    const slugs = rules.map((r) => r.slug);
    expect(slugs).toContain('graph:orphan-subtree');
    expect(slugs).toContain('graph:duplicated-function-body');
    expect(slugs).toContain('graph:no-side-effect-path');
    expect(slugs).toContain('graph:test-only-reachable');
    expect(slugs).toContain('graph:always-throws-branch');
  });
});
