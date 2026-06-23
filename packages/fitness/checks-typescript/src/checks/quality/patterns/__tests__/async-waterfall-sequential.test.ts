/**
 * @fileoverview Regression tests for `async-waterfall-detection` sequential
 * orchestration heuristics (P2.5). These patterns are deliberately sequential —
 * parallelizing them would break retry/backoff, ordered side-effects, or double
 * peak memory during full-repo scans.
 */

import { describe, expect, it } from 'vitest';

import { analyzeFile } from '../async-waterfall-analysis.js';

function analyze(src: string, filePath = 'src/svc/sample.ts'): readonly { line: number }[] {
  return analyzeFile(filePath, src);
}

describe('async-waterfall-detection — sequential orchestration', () => {
  it('does not flag backoff-then-retry in a retry loop', () => {
    const src = `
      async function runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
        for (let attempt = 0; attempt < 3; attempt++) {
          await backoff(attempt, [1000, 2000]);
          return await fn();
        }
        throw new Error('unreachable');
      }
    `;
    expect(analyze(src, 'packages/core/src/lib/execution/retry.ts')).toHaveLength(0);
  });

  it('does not flag runUnit-then-yieldToEventLoop between scheduler units', () => {
    const src = `
      async function run(unit: string): Promise<string> {
        const outcome = await opts.runUnit(unit, 0);
        await yieldToEventLoop();
        return outcome;
      }
    `;
    expect(analyze(src, 'packages/core/src/lib/execution/schedule.ts')).toHaveLength(0);
  });

  it('does not flag maybeShow-then-emit ordered sink delivery', () => {
    const src = `
      async function deliver(batch: unknown): Promise<void> {
        await maybeShowFirstRunNotice('/tmp/cache');
        await cloudSink.emit(batch);
      }
    `;
    expect(analyze(src, 'packages/output/src/sink/resolve-signal-sink.ts')).toHaveLength(0);
  });

  it('does not flag saveBaseline-then-render gate confirmation', () => {
    const src = `
      async function gate(cli: { saveBaseline: () => Promise<void>; render: (x: unknown) => Promise<void> }): Promise<void> {
        await cli.saveBaseline('fitness', {});
        await cli.render({ type: 'gate-done', lines: ['saved'] });
      }
    `;
    expect(analyze(src, 'packages/fitness/engine/src/cli/fit-modes.ts')).toHaveLength(0);
  });

  it('does not flag ensureAdapters-then-buildGraphCatalog', () => {
    const src = `
      async function build(cwd: string): Promise<void> {
        await ensureGraphAdaptersLoaded(cwd);
        await buildGraphCatalog(cwd, cli, { force: true });
      }
    `;
    expect(analyze(src, 'packages/yagni/engine/src/evidence/graph-evidence.ts')).toHaveLength(0);
  });

  it('does not flag collect-then-count sequential analyzeAll scans', () => {
    const src = `
      async function analyzeAll(files: unknown): Promise<void> {
        const configProperties = await collectConfigProperties(files);
        const accessCounts = await countPropertyAccesses(files);
        void configProperties;
        void accessCounts;
      }
    `;
    expect(
      analyze(src, 'packages/fitness/checks-typescript/src/checks/quality/unused-config-options.ts'),
    ).toHaveLength(0);
  });

  it('still flags independent parallelizable awaits', () => {
    const src = `
      declare function fetchUser(): Promise<string>;
      declare function fetchOrders(): Promise<string[]>;
      export async function load(): Promise<void> {
        const user = await fetchUser();
        const orders = await fetchOrders();
        void user;
        void orders;
      }
    `;
    expect(analyze(src).length).toBeGreaterThanOrEqual(1);
  });
});