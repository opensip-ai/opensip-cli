/**
 * Result/history tool handlers vs. a FAKE `ResultsReadPort` (Task 6.1 step 5).
 *
 * The result tools replay persisted sessions only — they NEVER re-run a tool.
 * Asserts each handler forwards its args to the port, validates `tool` against
 * the live registry (unknown → structured error), and surfaces the err arm.
 */

import { err, ok } from '@opensip-cli/core';
import { assembleAgentCatalog } from '@opensip-cli/shared-analysis';
import { describe, expect, it } from 'vitest';

import { registerCompareToBaseline } from '../compare-to-baseline.js';
import { registerGetAgentCatalog } from '../get-agent-catalog.js';
import { registerGetLatestFindings } from '../get-latest-findings.js';
import { registerListExecutionRuns } from '../list-execution-runs.js';
import { registerListRuns } from '../list-runs.js';
import { registerRepairApplyVerify } from '../repair-apply-verify.js';
import { registerReviewChange } from '../review-change.js';
import { registerShowExecutionRun } from '../show-execution-run.js';
import { registerShowRun } from '../show-run.js';

import type { McpReadReason, McpReadError } from '../../mcp-error.js';
import type { RepairApplyVerifyInput, RepairWritePort } from '../../repair-write-port.js';
import type {
  CompareToBaselineOptions,
  LatestFindingsOptions,
  McpBaselineComparisonData,
  McpExecutionRunDetailData,
  McpExecutionRunHistoryData,
  McpFinding,
  McpReviewChangeData,
  McpResultReplay,
  ReviewChangeOptions,
  RunSummary,
  ShowRunData,
} from '../../result-dto.js';
import type {
  ListExecutionRunsOptions,
  ListRunsOptions,
  ResultsReadPort,
  ShowExecutionRunOptions,
  ShowRunOptions,
} from '../../results-read-port.js';
import type { CallToolResult, McpStdioServer, McpSurfaceSnapshot } from '../../server.js';
import type { McpToolDeps } from '../types.js';
import type {
  AgentCatalog,
  RepairApplyVerifyResult,
  ReviewBrief,
  StoredRun,
  StoredRunStep,
} from '@opensip-cli/contracts';
import type { Result } from '@opensip-cli/core';

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

function captureServer(): { handlers: Map<string, Handler>; server: McpStdioServer } {
  const handlers = new Map<string, Handler>();
  const server = {
    register: (name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
      return undefined;
    },
  } as unknown as McpStdioServer;
  return { handlers, server };
}

function parseResult(result: CallToolResult): { isError: boolean; body: Record<string, unknown> } {
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

function fakeResults(over: Partial<ResultsReadPort>): ResultsReadPort {
  const base: ResultsReadPort = {
    agentCatalog: () => ok({ commands: [] } as unknown as AgentCatalog),
    listExecutionRuns: () =>
      ok({
        type: 'run-history',
        runs: [],
        requestedLimit: 20,
        effectiveLimit: 20,
        truncated: false,
      }),
    showExecutionRun: () => err({ code: 'test-dependency-unused' as McpReadReason, message: 'x' }),
    listRuns: () => ok([]),
    showRun: () =>
      Promise.resolve(err({ code: 'test-dependency-unused' as McpReadReason, message: 'x' })),
    latestFindings: () =>
      Promise.resolve(err({ code: 'test-dependency-unused' as McpReadReason, message: 'x' })),
    reviewChange: () =>
      Promise.resolve(err({ code: 'test-dependency-unused' as McpReadReason, message: 'x' })),
    compareToBaseline: () =>
      Promise.resolve(err({ code: 'test-dependency-unused' as McpReadReason, message: 'x' })),
  };
  return { ...base, ...over };
}

const GRAPH_FRESH = {
  fresh: true as const,
  builtAt: '2026-07-02T00:00:00.000Z',
  verifiedAt: '2026-07-02T00:00:01.000Z',
  verification: 'complete' as const,
};

function deps(results: ResultsReadPort, validToolIds = new Set(['fit', 'graph'])): McpToolDeps {
  return {
    graph: {
      catalogStatus: () =>
        Promise.resolve(
          ok({
            context: {
              project: {
                root: '/proj',
                scope: 'project' as const,
                configPath: 'opensip-cli.config.yml',
              },
              catalog: { status: 'loaded' as const, builtAt: GRAPH_FRESH.builtAt },
            },
            freshness: GRAPH_FRESH,
          }),
        ),
    } as unknown as McpToolDeps['graph'],
    codebase: {
      inventoryStatus: () =>
        Promise.resolve(
          err({
            code: 'test-dependency-unused' as McpReadReason,
            message: 'Codebase reads are not under test.',
          }),
        ),
      fileContext: () =>
        Promise.resolve(
          err({
            code: 'test-dependency-unused' as McpReadReason,
            message: 'Codebase reads are not under test.',
          }),
        ),
    },
    context: {
      contextStatus: () =>
        Promise.resolve(
          err({
            code: 'test-dependency-unused' as McpReadReason,
            message: 'Context reads are not under test.',
          }),
        ),
    },
    results,
    runtimeWiring: {} as McpToolDeps['runtimeWiring'],
    validToolIds,
  };
}

function repairResult(): RepairApplyVerifyResult {
  return {
    type: 'repair-apply-verify',
    status: 'applied',
    session: { id: 'sess-1', tool: 'fit' },
    signal: { id: 'sig-1', ruleId: 'rule-1', message: 'message', filePath: 'src/a.ts' },
    action: {
      id: 'replace-ts-ignore',
      kind: 'text-replacement',
      title: 'Replace',
      autofixable: true,
    },
    changes: [],
    force: false,
    verification: {
      status: 'verified',
      coverage: 'full',
      scope: {
        tool: 'fit',
        ruleId: 'rule-1',
        files: ['src/a.ts'],
        checkRan: true,
        changedImpacted: true,
        fallback: 'targeted',
      },
      commands: [],
      remainingFindings: [],
    },
  };
}

function reviewBrief(over: Partial<ReviewBrief> = {}): ReviewBrief {
  return {
    version: 1,
    suite: 'audit',
    suiteRunId: 'suite-1',
    verdict: 'pass',
    changedFiles: null,
    topRisks: [],
    newFindings: [],
    baselineDelta: { available: false, added: 0, removed: 0, unchanged: 0 },
    degraded: [],
    recommendedActions: [],
    ...over,
  };
}

function executionRun(): StoredRun {
  return {
    id: 'run-1',
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/proj',
    startedAt: '2026-07-02T00:00:00.000Z',
    completedAt: '2026-07-02T00:00:01.000Z',
    durationMs: 1000,
    exitCode: 0,
    aggregate: { steps: 1, passed: 1, failed: 0, faulted: 0, errors: 0, warnings: 0 },
  };
}

function executionStep(): StoredRunStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    logicalStepKey: 'fit',
    ordinal: 0,
    attempt: 1,
    tool: 'fit',
    command: 'opensip fit',
    stableId: 'fit',
    exitCode: 0,
    outcome: 'passed',
    durationMs: 1000,
    sessionId: 'session-1',
  };
}

// ── get_latest_findings ──────────────────────────────────────────────

describe('get_latest_findings handler', () => {
  it('forwards tool/severity/limit to the port and returns the replay', async () => {
    let seen: LatestFindingsOptions | undefined;
    const replay: McpResultReplay<readonly McpFinding[]> = {
      data: [{ ruleId: 'r', message: 'm', severity: 'high' }],
      filtersApplied: ['errors-only', 'top:3'],
    };
    const { server, handlers } = captureServer();
    registerGetLatestFindings(
      server,
      deps(
        fakeResults({
          latestFindings: (opts) => {
            seen = opts;
            return Promise.resolve(ok(replay));
          },
        }),
      ),
    );
    const out = parseResult(
      await handlers.get('get_latest_findings')!({
        tool: 'fit',
        severity: 'errors',
        limit: 3,
      }),
    );
    expect(seen).toEqual({ tool: 'fit', severity: 'errors', limit: 3 });
    expect((out.body.data as McpFinding[])[0]?.ruleId).toBe('r');
    expect(out.body.filtersApplied).toEqual(['errors-only', 'top:3']);
  });

  it('rejects an unknown tool with a structured unknown-tool error (no port call)', async () => {
    let called = false;
    const { server, handlers } = captureServer();
    registerGetLatestFindings(
      server,
      deps(
        fakeResults({
          latestFindings: () => {
            called = true;
            return Promise.resolve(ok({ data: [] }));
          },
        }),
      ),
    );
    const out = parseResult(await handlers.get('get_latest_findings')!({ tool: 'nope' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('unknown-tool');
    expect(called).toBe(false);
  });

  it('surfaces the port err arm', async () => {
    const { server, handlers } = captureServer();
    registerGetLatestFindings(
      server,
      deps(
        fakeResults({
          latestFindings: () => Promise.resolve(err({ code: 'not-found', message: 'no runs' })),
        }),
      ),
    );
    const out = parseResult(await handlers.get('get_latest_findings')!({ tool: 'fit' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('not-found');
  });
});

// ── repair_apply_verify ──────────────────────────────────────────────

describe('repair_apply_verify handler', () => {
  it('forwards apply-verify input to the repair write port', async () => {
    let seen: RepairApplyVerifyInput | undefined;
    const repairWrite: RepairWritePort = {
      applyVerify: (input) => {
        seen = input;
        return Promise.resolve(ok(repairResult()));
      },
    };
    const { server, handlers } = captureServer();
    registerRepairApplyVerify(server, {
      ...deps(fakeResults({})),
      repairWrite,
      mutationsEnabled: true,
    });

    const out = parseResult(
      await handlers.get('repair_apply_verify')!({
        ref: 'latest',
        tool: 'fit',
        signal: 'index:0',
        action: 'replace-ts-ignore',
        force: true,
      }),
    );

    expect(seen).toEqual({
      ref: 'latest',
      tool: 'fit',
      signal: 'index:0',
      action: 'replace-ts-ignore',
      force: true,
    });
    expect(out.body.type).toBe('repair-apply-verify');
  });

  it('rejects unknown tools before calling the mutating port', async () => {
    let called = false;
    const repairWrite: RepairWritePort = {
      applyVerify: () => {
        called = true;
        return Promise.resolve(ok(repairResult()));
      },
    };
    const { server, handlers } = captureServer();
    registerRepairApplyVerify(server, {
      ...deps(fakeResults({}), new Set(['fit'])),
      repairWrite,
      mutationsEnabled: true,
    });

    const out = parseResult(
      await handlers.get('repair_apply_verify')!({
        ref: 'latest',
        tool: 'graph',
        signal: 'index:0',
        action: 'replace-ts-ignore',
      }),
    );

    expect(called).toBe(false);
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('unknown-tool');
  });

  it('errors when mutations are disabled and when the write port fails', async () => {
    {
      const { server, handlers } = captureServer();
      registerRepairApplyVerify(server, {
        ...deps(fakeResults({})),
        // no repairWrite
      });
      const out = parseResult(
        await handlers.get('repair_apply_verify')!({
          ref: 'latest',
          tool: 'fit',
          signal: 'index:0',
          action: 'replace-ts-ignore',
        }),
      );
      expect(out.isError).toBe(true);
      expect((out.body.error as McpReadError).code).toBe('mcp-mutation-disabled');
    }
    {
      const repairWrite: RepairWritePort = {
        applyVerify: () =>
          Promise.resolve(
            err({ code: 'test-dependency-unused' as McpReadReason, message: 'nope' }),
          ),
      };
      const { server, handlers } = captureServer();
      registerRepairApplyVerify(server, {
        ...deps(fakeResults({})),
        repairWrite,
        mutationsEnabled: true,
      });
      const out = parseResult(
        await handlers.get('repair_apply_verify')!({
          ref: 'latest',
          tool: 'fit',
          signal: 'index:0',
          action: 'replace-ts-ignore',
          // force omitted branch
        }),
      );
      expect(out.isError).toBe(true);
      expect((out.body.error as McpReadError).code).toBe('test-dependency-unused');
    }
  });
});

// ── review_change ───────────────────────────────────────────────────

describe('review_change handler', () => {
  it('forwards suite filters, files, limit, and graph freshness to the port', async () => {
    let seen: ReviewChangeOptions | undefined;
    const replay: McpResultReplay<McpReviewChangeData> = {
      data: {
        reviewBrief: reviewBrief(),
        source: { suiteRunId: 'suite-1', suiteName: 'audit', sessionIds: ['fit-1'] },
        freshness: {
          graph: GRAPH_FRESH,
          sessions: {
            replayedAt: '2026-07-02T00:00:01.000Z',
            replayedSessions: 1,
            degradedSteps: 0,
          },
        },
      },
    };
    const { server, handlers } = captureServer();
    registerReviewChange(
      server,
      deps(
        fakeResults({
          reviewChange: (opts) => {
            seen = opts;
            return Promise.resolve(ok(replay));
          },
        }),
      ),
    );
    const out = parseResult(
      await handlers.get('review_change')!({
        suiteRunId: 'suite-1',
        suite: 'audit',
        files: ['src/a.ts'],
        limit: 5,
      }),
    );
    expect(seen).toEqual({
      suiteRunId: 'suite-1',
      suite: 'audit',
      files: ['src/a.ts'],
      limit: 5,
      graphFreshness: GRAPH_FRESH,
    });
    expect((out.body.data as McpReviewChangeData).reviewBrief.version).toBe(1);
  });

  it('surfaces the port err arm', async () => {
    const { server, handlers } = captureServer();
    registerReviewChange(
      server,
      deps(
        fakeResults({
          reviewChange: () => Promise.resolve(err({ code: 'not-found', message: 'no suite' })),
        }),
      ),
    );
    const out = parseResult(await handlers.get('review_change')!({ suiteRunId: 'missing' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('not-found');
  });

  it('degrades graph status errors and still replays stored review data', async () => {
    let seen: ReviewChangeOptions | undefined;
    const base = deps(
      fakeResults({
        reviewChange: (opts) => {
          seen = opts;
          return Promise.resolve(
            ok({
              data: {
                reviewBrief: reviewBrief(),
                source: { suiteRunId: 'suite-1', suiteName: 'audit', sessionIds: ['fit-1'] },
                freshness: {
                  graph: opts.graphFreshness,
                  sessions: {
                    replayedAt: '2026-07-02T00:00:01.000Z',
                    replayedSessions: 1,
                    degradedSteps: 0,
                  },
                },
              },
            }),
          );
        },
      }),
    );
    const { server, handlers } = captureServer();
    registerReviewChange(server, {
      ...base,
      graph: {
        catalogStatus: () =>
          Promise.resolve(
            err({
              code: 'catalog-generation',
              operation: 'catalog-generation',
              message: 'Failed to load graph catalog generation',
            }),
          ),
      } as unknown as McpToolDeps['graph'],
    });

    const out = parseResult(await handlers.get('review_change')!({}));
    expect(out.isError).toBe(false);
    expect(seen?.graphFreshness).toMatchObject({
      fresh: false,
      verification: 'partial',
      reasonCode: 'verification-unavailable',
      reason: 'Graph status unavailable',
    });
  });
});

// ── compare_to_baseline ─────────────────────────────────────────────

describe('compare_to_baseline handler', () => {
  it('forwards tool/ref/limit/includeResolved to the port', async () => {
    let seen: CompareToBaselineOptions | undefined;
    const replay: McpResultReplay<McpBaselineComparisonData> = {
      data: {
        tool: 'fit',
        baseline: { available: true, rowCount: 1 },
        delta: { added: 1, resolved: 0, unchanged: 0, missingFingerprint: 0 },
        addedFindings: [{ ruleId: 'r', message: 'm', severity: 'high' }],
      },
    };
    const { server, handlers } = captureServer();
    registerCompareToBaseline(
      server,
      deps(
        fakeResults({
          compareToBaseline: (opts) => {
            seen = opts;
            return Promise.resolve(ok(replay));
          },
        }),
      ),
    );
    const out = parseResult(
      await handlers.get('compare_to_baseline')!({
        tool: 'fit',
        ref: 'fit-1',
        limit: 10,
        includeResolved: true,
      }),
    );
    expect(seen).toEqual({ tool: 'fit', ref: 'fit-1', limit: 10, includeResolved: true });
    expect((out.body.data as McpBaselineComparisonData).delta.added).toBe(1);
  });

  it('rejects an unknown tool with a structured unknown-tool error (no port call)', async () => {
    let called = false;
    const { server, handlers } = captureServer();
    registerCompareToBaseline(
      server,
      deps(
        fakeResults({
          compareToBaseline: () => {
            called = true;
            return Promise.resolve(ok({ data: {} as McpBaselineComparisonData }));
          },
        }),
      ),
    );
    const out = parseResult(await handlers.get('compare_to_baseline')!({ tool: 'nope' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('unknown-tool');
    expect(called).toBe(false);
  });

  it('surfaces the port err arm', async () => {
    const { server, handlers } = captureServer();
    registerCompareToBaseline(
      server,
      deps(
        fakeResults({
          compareToBaseline: () =>
            Promise.resolve(err({ code: 'not-found', message: 'no session' })),
        }),
      ),
    );
    const out = parseResult(await handlers.get('compare_to_baseline')!({ tool: 'fit' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('not-found');
  });
});

// ── canonical execution Runs ─────────────────────────────────────────

describe('list_execution_runs handler', () => {
  it('forwards the optional bound and returns the exact canonical history DTO', () => {
    let seen: ListExecutionRunsOptions | undefined;
    let legacyCalled = false;
    const history: McpExecutionRunHistoryData = {
      type: 'run-history',
      runs: [{ run: executionRun(), showCommand: 'opensip runs show run-1 --json' }],
      requestedLimit: 3,
      effectiveLimit: 3,
      truncated: false,
    };
    const { server, handlers } = captureServer();
    registerListExecutionRuns(
      server,
      deps(
        fakeResults({
          listExecutionRuns: (opts) => {
            seen = opts;
            return ok(history);
          },
          listRuns: () => {
            legacyCalled = true;
            return ok([]);
          },
        }),
      ),
    );

    const out = parseResult(handlers.get('list_execution_runs')!({ limit: 3 }) as CallToolResult);
    expect(seen).toEqual({ limit: 3 });
    expect(out.body).toEqual(history);
    expect(legacyCalled).toBe(false);
  });

  it('passes an empty option object and surfaces a fixed port error arm', () => {
    let seen: ListExecutionRunsOptions | undefined;
    const { server, handlers } = captureServer();
    registerListExecutionRuns(
      server,
      deps(
        fakeResults({
          listExecutionRuns: (opts) => {
            seen = opts;
            return err({
              code: 'execution-run-read-failed',
              message: 'Stored evidence failed.',
            });
          },
        }),
      ),
    );

    const out = parseResult(handlers.get('list_execution_runs')!({}) as CallToolResult);
    expect(seen).toEqual({});
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('execution-run-read-failed');
  });
});

describe('show_execution_run handler', () => {
  it('forwards exact identity and pagination without invoking legacy Session replay', () => {
    let seen: ShowExecutionRunOptions | undefined;
    let legacyCalled = false;
    const detail: McpExecutionRunDetailData = {
      type: 'run-detail',
      run: executionRun(),
      steps: [executionStep()],
      offset: 2,
      limit: 4,
      total: 7,
      nextOffset: 3,
      sessionFollowUps: [
        {
          runStepId: 'step-1',
          sessionId: 'session-1',
          showCommand: 'opensip sessions show session-1 --json',
        },
      ],
    };
    const { server, handlers } = captureServer();
    registerShowExecutionRun(
      server,
      deps(
        fakeResults({
          showExecutionRun: (opts) => {
            seen = opts;
            return ok(detail);
          },
          showRun: () => {
            legacyCalled = true;
            return Promise.resolve(
              err({ code: 'test-dependency-unused' as McpReadReason, message: 'unexpected' }),
            );
          },
        }),
      ),
    );

    const out = parseResult(
      handlers.get('show_execution_run')!({
        runId: 'run-1',
        offset: 2,
        limit: 4,
      }) as CallToolResult,
    );
    expect(seen).toEqual({ runId: 'run-1', offset: 2, limit: 4 });
    expect(out.body).toEqual(detail);
    expect(legacyCalled).toBe(false);
  });

  it('omits absent pagination fields and surfaces not-found', () => {
    let seen: ShowExecutionRunOptions | undefined;
    const { server, handlers } = captureServer();
    registerShowExecutionRun(
      server,
      deps(
        fakeResults({
          showExecutionRun: (opts) => {
            seen = opts;
            return err({
              code: 'not-found',
              message: 'Execution Run was not found.',
            });
          },
        }),
      ),
    );

    const out = parseResult(
      handlers.get('show_execution_run')!({ runId: 'missing' }) as CallToolResult,
    );
    expect(seen).toEqual({ runId: 'missing' });
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('not-found');
  });
});

// ── list_runs ────────────────────────────────────────────────────────

describe('list_runs handler', () => {
  it('forwards tool/limit/summaryOnly and wraps rows under { runs }', () => {
    let seen: ListRunsOptions | undefined;
    const row: RunSummary = {
      id: 's1',
      tool: 'fit',
      startedAt: 't',
      completedAt: 't',
      durationMs: 1,
      score: 90,
      passed: true,
      showCommand: 'opensip sessions show s1 --json',
    };
    const { server, handlers } = captureServer();
    registerListRuns(
      server,
      deps(
        fakeResults({
          listRuns: (opts): Result<readonly RunSummary[], McpReadError> => {
            seen = opts;
            return ok([row]);
          },
        }),
      ),
    );
    const out = parseResult(
      handlers.get('list_runs')!({ tool: 'fit', limit: 10, summaryOnly: true }) as CallToolResult,
    );
    expect(seen).toEqual({ tool: 'fit', limit: 10, summaryOnly: true });
    expect((out.body.runs as RunSummary[])[0]?.id).toBe('s1');
  });

  it('lists with no arguments (all optional filters omitted)', () => {
    let seen: ListRunsOptions | undefined;
    const { server, handlers } = captureServer();
    registerListRuns(
      server,
      deps(
        fakeResults({
          listRuns: (opts) => {
            seen = opts;
            return ok([]);
          },
        }),
      ),
    );
    const out = parseResult(handlers.get('list_runs')!({}) as CallToolResult);
    expect(out.isError).toBe(false);
    expect(seen).toEqual({});
  });

  it('rejects an unknown tool filter, naming "(none registered)" when no tools exist', () => {
    const { server, handlers } = captureServer();
    registerListRuns(server, deps(fakeResults({ listRuns: () => ok([]) }), new Set()));
    const out = parseResult(handlers.get('list_runs')!({ tool: 'nope' }) as CallToolResult);
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).message).toContain('(none registered)');
  });

  it('surfaces a listRuns port error', () => {
    const { server, handlers } = captureServer();
    registerListRuns(
      server,
      deps(
        fakeResults({
          listRuns: () => err({ code: 'graph-read-failed', message: 'x' }),
        }),
      ),
    );
    const out = parseResult(handlers.get('list_runs')!({}) as CallToolResult);
    expect(out.isError).toBe(true);
  });
});

// ── show_run ─────────────────────────────────────────────────────────

describe('show_run handler', () => {
  it('forwards ref/tool/filters/raw to the port', async () => {
    let seen: ShowRunOptions | undefined;
    const { server, handlers } = captureServer();
    registerShowRun(
      server,
      deps(
        fakeResults({
          showRun: (opts) => {
            seen = opts;
            return Promise.resolve(
              ok({
                data: { fidelity: 'projection' } as ShowRunData,
              }),
            );
          },
        }),
      ),
    );
    await handlers.get('show_run')!({
      ref: 'latest',
      tool: 'fit',
      filters: ['errors-only'],
      raw: true,
    });
    expect(seen).toEqual({ ref: 'latest', tool: 'fit', filters: ['errors-only'], raw: true });
  });

  it('rejects an unknown tool sanity-check', async () => {
    const { server, handlers } = captureServer();
    registerShowRun(server, deps(fakeResults({})));
    const out = parseResult(await handlers.get('show_run')!({ ref: 'latest', tool: 'nope' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('unknown-tool');
  });

  it('surfaces a not-found err arm', async () => {
    const { server, handlers } = captureServer();
    registerShowRun(
      server,
      deps(
        fakeResults({
          showRun: () => Promise.resolve(err({ code: 'not-found', message: 'no session' })),
        }),
      ),
    );
    const out = parseResult(await handlers.get('show_run')!({ ref: 'nope' }));
    expect(out.isError).toBe(true);
    expect((out.body.error as McpReadError).code).toBe('not-found');
  });
});

// ── get_agent_catalog ────────────────────────────────────────────────

describe('get_agent_catalog handler', () => {
  /** A representative common catalog with reserved names + project + hostSupport. */
  function commonCatalog(): AgentCatalog {
    return assembleAgentCatalog({
      rootCommands: ['audit', 'init', 'sessions', 'suite'],
      suiteNames: ['audit', 'agent-context'],
      hostSupport: {
        supportContractVersion: 1,
        status: 'preview',
        match: 'partial',
        rowId: 'macos-26-arm64-node24-npm11-v1',
        rowStatus: 'preview',
        profile: { id: 'macos-26-arm64-node24-npm11-v1', version: 1 },
        matrixUrl: 'https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms',
        reasonCodes: [],
        observed: ['os-platform', 'arch', 'node-major', 'node-abi'],
        unobserved: ['npm-major', 'filesystem-type', 'install-channel'],
      },
    });
  }

  const SURFACE: McpSurfaceSnapshot = Object.freeze({
    version: '9.9.9-test',
    surfaceEpoch: 7,
    toolNames: Object.freeze(['get_agent_catalog', 'search_symbols']),
    toolCount: 2,
    mutationPosture: 'read-only',
    projectRoot: '/canonical/project/root',
    projectScope: 'project',
  });

  it('returns the bare common catalog when mcpSurface is absent (no overlay)', () => {
    const catalog = commonCatalog();
    const { server, handlers } = captureServer();
    // deps() does not set mcpSurface → the handler must return the bare catalog.
    registerGetAgentCatalog(server, deps(fakeResults({ agentCatalog: () => ok(catalog) })));
    const out = parseResult(handlers.get('get_agent_catalog')!({}) as CallToolResult);
    expect(out.isError).toBe(false);
    expect(out.body).toEqual(catalog);
    expect(out.body).not.toHaveProperty('mcp');
  });

  it('surfaces an err arm', () => {
    const { server, handlers } = captureServer();
    registerGetAgentCatalog(
      server,
      deps(
        fakeResults({
          agentCatalog: () => err({ code: 'graph-read-failed', message: 'x' }),
        }),
      ),
    );
    const out = parseResult(handlers.get('get_agent_catalog')!({}) as CallToolResult);
    expect(out.isError).toBe(true);
  });

  it('adds ONLY the additive mcp overlay from McpSurfaceSnapshot, leaving the common body unchanged', () => {
    const catalog = commonCatalog();
    const { server, handlers } = captureServer();
    registerGetAgentCatalog(server, {
      ...deps(fakeResults({ agentCatalog: () => ok(catalog) })),
      mcpSurface: () => SURFACE,
    });
    const out = parseResult(handlers.get('get_agent_catalog')!({}) as CallToolResult);
    expect(out.isError).toBe(false);

    // The `mcp` overlay carries EXACTLY the McpSurfaceSnapshot fields, mapped
    // verbatim (projectRoot → project.root, projectScope → project.scope).
    expect(out.body.mcp).toEqual({
      version: '9.9.9-test',
      surfaceEpoch: 7,
      toolNames: ['get_agent_catalog', 'search_symbols'],
      toolCount: 2,
      mutationPosture: 'read-only',
      project: { root: '/canonical/project/root', scope: 'project' },
    });

    // Removing ONLY the named `mcp` overlay yields the untouched common catalog —
    // no other field was added, renamed, or dropped (no wildcard omission list).
    const common: Record<string, unknown> = { ...out.body };
    delete common.mcp;
    expect(common).toEqual(catalog);
  });

  it('never mutates the input catalog when composing the overlay', () => {
    const catalog = commonCatalog();
    const before = JSON.stringify(catalog);
    const { server, handlers } = captureServer();
    registerGetAgentCatalog(server, {
      ...deps(fakeResults({ agentCatalog: () => ok(catalog) })),
      mcpSurface: () => SURFACE,
    });
    void handlers.get('get_agent_catalog')!({});
    // The catalog the read port returned is untouched — the overlay is additive.
    expect(JSON.stringify(catalog)).toBe(before);
    expect(catalog).not.toHaveProperty('mcp');
  });
});
