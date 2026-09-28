/**
 * Rule registry conformance test (PR-1, PR-16).
 *
 * Asserts every entry in the rule registry has a non-empty graph:
 * slug, valid defaultSeverity, and a callable evaluate function.
 *
 * Item 1: the rule registry is per-RunScope. Each test enters a fresh
 * scope (with graph subscope) and reads via `currentRules()`.
 */

import { RunScope, applyToolContributeScope, runWithScopeSync } from '@opensip-cli/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { currentRules } from '../../rules/registry.js';
import { graphTool } from '../../tool.js';

import type { Rule } from '../../types.js';

let rules: readonly Rule[];
let scope: RunScope;

beforeEach(() => {
  scope = new RunScope();
  applyToolContributeScope(scope, graphTool);
  rules = runWithScopeSync(scope, () => currentRules());
});

describe('rules registry conformance', () => {
  it('registry is non-empty', () =>
    runWithScopeSync(scope, () => {
      expect(rules.length).toBeGreaterThan(0);
    }));

  it('every rule has a graph: slug', () =>
    runWithScopeSync(scope, () => {
      for (const r of rules) {
        expect(r.slug.startsWith('graph:')).toBe(true);
        expect(r.slug.length).toBeGreaterThan('graph:'.length);
      }
    }));

  it('every rule has a valid defaultSeverity', () =>
    runWithScopeSync(scope, () => {
      for (const r of rules) {
        expect(['error', 'warning']).toContain(r.defaultSeverity);
      }
    }));

  it('every rule has a callable evaluate', () =>
    runWithScopeSync(scope, () => {
      for (const r of rules) {
        expect(typeof r.evaluate).toBe('function');
      }
    }));

  it('the built-in rule set is registered', () =>
    runWithScopeSync(scope, () => {
      const slugs = rules.map((r) => r.slug);
      expect(slugs).toContain('graph:orphan-subtree');
      expect(slugs).toContain('graph:duplicated-function-body');
      expect(slugs).toContain('graph:near-duplicate-function-body');
      expect(slugs).toContain('graph:no-side-effect-path');
      expect(slugs).toContain('graph:test-only-reachable');
      expect(slugs).toContain('graph:always-throws-branch');
    }));
});
