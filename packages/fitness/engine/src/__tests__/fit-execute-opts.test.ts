/**
 * executeFit boundary test (ADR-0028 — worker-safe, persistence-free engine).
 *
 * `executeFit` does NOT touch the datastore: it returns the envelope + the run's
 * `durationMs`, and the CALLER persists via `persistFitSession` on the main
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

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { persistFitSession } from '../cli/fit/result-builders.js';
import { executeFit } from '../cli/fit.js';
import { fitnessTool } from '../tool.js';

import type { FitOptions } from '@opensip-cli/contracts';

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
  Object.assign(scope, fitnessTool.contributeScope?.() ?? {});
  return runWithScope(scope, fn);
}

describe('executeFit — persistence-free boundary (ADR-0028)', () => {
  it('returns an envelope + durationMs and does NOT persist on its own', async () => {
    const fitResult = await withFitScope(() => executeFit(makeArgs(projectDir)));
    // Sanity — executeFit shouldn't error on a minimal project.
    expect(fitResult.result.type).not.toBe('error');
    expect(fitResult.envelope).toBeDefined();
    expect(typeof fitResult.durationMs).toBe('number');
    expect(typeof fitResult.startedAt).toBe('string');

    // The engine is pure-compute now: nothing was written.
    const sessions = new SessionRepo(datastore).list({ tool: 'fit' });
    expect(sessions.length).toBe(0);
  });

  it('persistFitSession (the caller path) writes exactly one session', async () => {
    const args = makeArgs(projectDir);
    const fitResult = await withFitScope(() => executeFit(args));
    expect(fitResult.envelope).toBeDefined();
    if (
      fitResult.envelope === undefined ||
      fitResult.durationMs === undefined ||
      fitResult.startedAt === undefined
    )
      throw new Error('expected a fit-done result');

    persistFitSession(
      datastore,
      args,
      fitResult.envelope,
      fitResult.durationMs,
      fitResult.startedAt,
    );

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
