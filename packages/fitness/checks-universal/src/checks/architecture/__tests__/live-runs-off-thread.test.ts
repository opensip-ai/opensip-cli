/**
 * Unit tests for the pure `analyzeLiveRunsOffThread` detector behind the
 * `live-runs-off-thread` check (ADR-0028). The detector operates on
 * `strip-strings-and-comments`-filtered content (the framework applies the
 * `contentFilter` before calling `analyze`) and is path-scoped: it fires only on
 * `*-runner.tsx` (in-process transport call) and `*-worker.ts` (persistence call).
 *
 * Modelled on `restrict-raw-db-access.test.ts` — a pure
 * `(content, filePath) => violations[]` detector exercised with no framework.
 */
import { describe, expect, it } from 'vitest';

import { analyzeLiveRunsOffThread } from '../live-runs-off-thread.js';

describe('analyzeLiveRunsOffThread', () => {
  it('flags a live runner that calls the bare in-process transport', () => {
    const v = analyzeLiveRunsOffThread(
      'const run = createInProcessTransport().run(fn);',
      'cli/fit-runner.tsx',
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('OFF the main process');
  });

  it('flags a worker entry that persists', () => {
    const v = analyzeLiveRunsOffThread(
      'persistSession({ cwd }, signals, ds, ms);',
      'cli/graph-worker.ts',
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('only COMPUTE');
  });

  it('passes a runner that uses the off-thread selector', () => {
    expect(
      analyzeLiveRunsOffThread(
        'const run = runOffThreadOrInProcess({ descriptor, inProcess });',
        'cli/sim-runner.tsx',
      ),
    ).toEqual([]);
  });

  it('passes a worker that reads the scope datastore but does not persist', () => {
    expect(
      analyzeLiveRunsOffThread(
        'const ds = cli.scope.datastore(); await runEngine(spec, ds);',
        'cli/graph-worker.ts',
      ),
    ).toEqual([]);
  });

  it('only the runner rule applies to runners (a persist call in a runner is not flagged by the worker rule)', () => {
    // A runner calling createInProcessTransport is flagged; the worker-only
    // persist rule does not apply to a *-runner.tsx file.
    const v = analyzeLiveRunsOffThread(
      'persistSession(x); createInProcessTransport();',
      'cli/fit-runner.tsx',
    );
    expect(v).toHaveLength(1);
  });

  it('ignores files that are neither runners nor workers', () => {
    expect(
      analyzeLiveRunsOffThread(
        'createInProcessTransport(); persistSession(x);',
        'cli/fit-modes.ts',
      ),
    ).toEqual([]);
  });

  it('skips test files even when named like a runner/worker', () => {
    expect(
      analyzeLiveRunsOffThread('createInProcessTransport();', 'cli/__tests__/fit-runner.test.tsx'),
    ).toEqual([]);
    expect(analyzeLiveRunsOffThread('persistSession(x);', 'cli/graph-worker.test.ts')).toEqual([]);
  });
});
