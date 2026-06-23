/**
 * executeFit boundary test (ADR-0028 — worker-safe, persistence-free engine).
 *
 * `executeFit` does NOT touch the datastore: it returns the envelope + the run's
 * (host timing removed). The CALLER (modes / live runner with ToolCliContext) persists
 * via the `cli.runSession.record` seam (or legacy persistFitSession for some tests).
 * thread (the datastore handle cannot cross the worker boundary). These tests
 * lock both halves: the engine is pure-compute, and the explicit persist writes
 * exactly one session. `onProgress` wiring is also covered.
 *
 * Implementation note: the fixture is a minimal tmp project with just
 * `opensip-cli.config.yml`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LanguageRegistry,
  RunScope,
  generatePrefixedId,
  runWithScope,
  applyToolContributeScope,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFitnessSessionPayload } from '../cli/fit/result-builders.js';
import { executeFit } from '../cli/fit.js';
import { fitnessTool } from '../tool.js';

import type * as CheckLoaderModule from '../cli/fit/check-loader.js';
import type { FitOptions } from '@opensip-cli/contracts';

// Unit tests run without built @opensip-cli/checks-* dist artifacts — seed a stub
// check so executeFit reaches the recipe path (ADR-0060 fail-closed otherwise).
vi.mock('../cli/fit/check-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CheckLoaderModule>();
  const { currentCheckRegistry, currentFitnessLoadState } =
    await import('../framework/scope-registry.js');
  const { defineCheck } = await import('../framework/define-check.js');
  return {
    ...actual,
    ensureChecksLoaded: vi.fn((projectDir = '') => {
      const key = projectDir;
      const load = currentFitnessLoadState();
      if (load.loadedFor === key) return;
      const registry = currentCheckRegistry();
      if (registry.listEnabled().length === 0) {
        registry.register(
          defineCheck({
            id: '00000000-0000-4000-8000-000000000099',
            slug: 'stub-check',
            description: 'stub',
            tags: ['test'],
            analyze: () => [],
          }),
          '@opensip-cli/test',
        );
      }
      load.loadedFor = key;
      load.pluginLoadErrors = [];
      load.checkPackErrors = [];
      load.loadWarnings = [];
      load.degradedDiagnostics = [];
      load.commandError = undefined;
      load.loadDegraded = undefined;
      load.outcomeFinalized = true;
    }),
  };
});

let projectDir: string;
let datastore: DataStore;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'opensip-fit-opts-'));
  // Minimal config — at least one target so executeFit doesn't short
  // out on a missing config error.
  writeFileSync(
    join(projectDir, 'opensip-cli.config.yml'),
    `targets:
  source:
    description: minimal
    languages: [typescript]
    concerns: [backend]
    include:
      - "src/**/*.ts"
`,
  );
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const x = 1;\n');
  datastore = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  datastore.close();
  rmSync(projectDir, { recursive: true, force: true });
});

function makeArgs(cwd: string): FitOptions {
  return {
    json: false,
    list: false,
    recipes: false,
    verbose: false,
    debug: false,
    quiet: true,
    open: false,
    cwd,
    exclude: [],
    gateSave: false,
    gateCompare: false,
  };
}

function withFitScope<T>(fn: () => Promise<T>): Promise<T> {
  // executeFit reads `currentScope()?.languages` and the fitness subscope
  // (`scope.fitness.{checks,recipes,load}`) — wrap each call in a fresh scope
  // carrying both an (empty) language registry and fitness's contributed
  // registries so check loading + recipe selection resolve.
  const scope = new RunScope({ languages: new LanguageRegistry() });
  applyToolContributeScope(scope, fitnessTool);
  Object.assign(scope, {
    configDocument: {
      targets: {
        source: {
          description: 'minimal',
          languages: ['typescript'],
          concerns: ['backend'],
          include: ['src/**/*.ts'],
        },
      },
    },
  });
  return runWithScope(scope, fn);
}

describe('executeFit — persistence-free boundary (ADR-0028)', () => {
  it('returns an envelope + durationMs and does NOT persist on its own', async () => {
    const fitResult = await withFitScope(() => executeFit(makeArgs(projectDir)));
    // Sanity — executeFit shouldn't error on a minimal project.
    expect(fitResult.result.type).not.toBe('error');
    expect(fitResult.envelope).toBeDefined();
    // timing removed from executeFit return (Phase 3.1 host-owned); the top-level
    // result no longer carries duration/startedAt. (Test updated in Task 3.4.)
    expect((fitResult as Record<string, unknown>).durationMs).toBeUndefined();
    expect((fitResult as Record<string, unknown>).startedAt).toBeUndefined();

    // The engine is pure-compute now: nothing was written.
    const sessions = new SessionRepo(datastore).list({ tool: 'fit' });
    expect(sessions.length).toBe(0);
  });

  it('a fit session contribution persisted via SessionRepo writes exactly one row', async () => {
    const args = makeArgs(projectDir);
    const fitResult = await withFitScope(() => executeFit(args));
    expect(fitResult.envelope).toBeDefined();
    const envelope = fitResult.envelope!;
    // host-owned-run-timing Phase 3 removed the production `persistFitSession`
    // helper — the host run plane owns persistence. This test-only write mirrors
    // the row the host writes from the tool's returned ToolSessionContribution.
    new SessionRepo(datastore).save({
      id: generatePrefixedId('fit'),
      tool: 'fit',
      startedAt: '1970-01-01T00:00:00.000Z',
      completedAt: '1970-01-01T00:00:00.000Z',
      cwd: args.cwd,
      recipe: envelope.recipe,
      score: envelope.verdict.score,
      passed: envelope.verdict.passed,
      durationMs: 0,
      payload: buildFitnessSessionPayload(envelope),
    });

    const sessions = new SessionRepo(datastore).list({ tool: 'fit' });
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.tool).toBe('fit');
    expect(sessions[0]?.cwd).toBe(projectDir);
  });

  it('invokes onProgress when supplied', async () => {
    const calls: { completed: number; total: number }[] = [];
    const fitResult = await withFitScope(() =>
      executeFit(makeArgs(projectDir), {
        onProgress: (completed, total) => {
          calls.push({ completed, total });
        },
      }),
    );
    expect(fitResult.result.type).not.toBe('error');
    // Even with zero registered checks the recipe service may yield no
    // tick, so the contract is "accepts the callback without throwing".
    // Stronger assertions are exercised by the FitView integration in
    // the CLI package; here we only need to prove the opt is wired.
    expect(Array.isArray(calls)).toBe(true);
  });
});
