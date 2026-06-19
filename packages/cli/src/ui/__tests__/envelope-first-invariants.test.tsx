/**
 * Envelope-first-presentation — the three invariants that the rest of the Phase 4
 * suite leaves implicit (see the phase file's "ADD only what is missing"):
 *
 *   1. Error-before-envelope renders the `error` variant, NEVER a
 *      `run-presentation`. When a run faults before an envelope exists
 *      (`executeFit`/`executeSim` returning an `ErrorResult`), `resultToView`
 *      must route through `errorView` — the `✗`-marked structured error — and a
 *      `RunPresentation` is constructed only when an envelope exists (plan
 *      Assumption 5). This pins that the two render paths are disjoint and that
 *      the error path produces no envelope-derived table.
 *
 *   2. Session-replay remains an envelope-derived detail view. Fresh non-verbose
 *      runs intentionally render the compact summary/footer surface; replay still
 *      derives its body from `envelopeToTableView`, so historical inspection can
 *      show the per-unit table without changing default run output.
 *
 *   3. `run-presentation.ts` adds no `cli-ui` (or any UI) edge. The render-only
 *      `RunPresentation` type stays UI-free; the `contracts-imports-core-only`
 *      dependency-cruiser rule forbids a contracts→cli-ui edge (RP-0 Task 0.3).
 *      `pnpm lint` runs the cruiser gate; this test pins the rule's `to`-list and
 *      the source module's import surface so a future edit can't silently add a
 *      UI import to the type and slip past review.
 *
 * These are additive: the byte-identity (golden-fixtures), graph enumerated-delta
 * (result-to-view / cross-renderer), live/static parity (graph-live-static-parity /
 * fit-modes-live), `--json` contract (envelope-routing / json-contract /
 * session-show), duration-override (result-to-view), and fingerprint
 * byte-preservation (graph baseline-plane) assertions live in their own files and
 * are not duplicated here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToText } from '@opensip-cli/cli-ui';
import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';

import { resultToView } from '../result-to-view.js';

import type {
  CommandResult,
  ErrorResult,
  RunPresentation,
  SessionReplayResult,
  SignalEnvelope,
} from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

const CREATED_AT = '2026-06-04T00:00:00.000Z';

function textOf(result: CommandResult): string {
  return renderToText(resultToView(result));
}

/** A representative fit envelope: one failing + one passing unit, two findings. */
function fitEnvelope(): SignalEnvelope {
  const signal = (source: string, line: number): Signal => ({
    id: `sig_${source}_${String(line)}`,
    source,
    provider: 'opensip-cli',
    severity: 'high',
    category: 'quality',
    ruleId: source,
    message: 'console.log',
    filePath: 'a.ts',
    line,
    metadata: {},
    createdAt: CREATED_AT,
  });
  return buildSignalEnvelope({
    tool: 'fit',
    runId: 'FIT_REPLAY',
    createdAt: CREATED_AT,
    units: [
      {
        slug: 'no-console',
        passed: false,
        durationMs: 5,
        filesValidated: 10,
        itemType: 'files',
        ignoredCount: 0,
      },
      {
        slug: 'naming',
        passed: true,
        durationMs: 3,
        filesValidated: 10,
        itemType: 'files',
        ignoredCount: 0,
      },
    ],
    signals: [signal('no-console', 3), signal('no-console', 4)],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
  });
}

// ---------------------------------------------------------------------------
// 1. Error-before-envelope renders the `error` variant, never a RunPresentation.
// ---------------------------------------------------------------------------

describe('error-before-envelope renders ErrorResult, never a RunPresentation', () => {
  // The exact shape `executeFit`/`executeSim` return when a run faults before an
  // envelope exists (unknown recipe, no scenarios, missing config). The handlers
  // (`fit-modes.ts`, sim `tool.ts`) call `cli.render(result)` with THIS object —
  // never a `run-presentation` — and the host routes it through `errorView`.
  const errorResult: ErrorResult = {
    type: 'error',
    message: "Unknown sim recipe 'nope'.",
    suggestion: 'Run `opensip sim --recipes` to see available recipes.',
    exitCode: 2,
  };

  it('routes the error variant to the ✗-marked structured error view (not presentationToView)', () => {
    const out = textOf(errorResult);
    // errorView renders the `✗` marker + indented suggestion (result-to-view.ts).
    expect(out).toBe(
      "  ✗ Unknown sim recipe 'nope'.\n      Run `opensip sim --recipes` to see available recipes.",
    );
    // It is emphatically NOT the envelope-derived run table: no per-unit table
    // header, no PASS/FAIL verdict summary, no `--verbose` footer hint.
    expect(out).not.toContain('Status');
    expect(out).not.toContain('Duration');
    expect(out).not.toMatch(/\b(PASS|FAIL)\b/);
    expect(out).not.toContain('Use --verbose for detailed results');
  });

  it('renders a bare error (no suggestion) the same way — still no run table', () => {
    const out = textOf({ type: 'error', message: 'No config found.', exitCode: 2 });
    expect(out).toBe('  ✗ No config found.');
    expect(out).not.toContain('Status');
  });

  it('the error view shares no rendered tokens with a run-presentation of the same run', () => {
    // A fault-path render and the would-be success render of the same logical run
    // must be disjoint: the error path produces none of the table/summary tokens.
    const presentation: RunPresentation = {
      type: 'run-presentation',
      tool: 'fitness',
      envelope: fitEnvelope(),
    };
    const presentationText = textOf(presentation);
    const errorText = textOf(errorResult);
    expect(presentationText).toMatch(/\b(PASS|FAIL)\b/);
    expect(errorText).not.toMatch(/\b(PASS|FAIL)\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. Session-replay renders identically to a fresh run of the same envelope.
// ---------------------------------------------------------------------------

describe('session-replay keeps the envelope-derived detail table', () => {
  const envelope = fitEnvelope();

  const presentation: RunPresentation = {
    type: 'run-presentation',
    tool: 'fitness',
    envelope,
  };

  const replay: SessionReplayResult = {
    type: 'session-replay',
    session: {
      id: 'FIT_REPLAY',
      tool: 'fit',
      startedAt: CREATED_AT,
      completedAt: CREATED_AT,
      score: envelope.verdict.score,
      passed: envelope.verdict.passed,
      durationMs: 8,
    },
    envelope,
    fidelity: 'projection',
  };

  it('the replay body contains the per-unit table while a fresh non-verbose run stays compact', () => {
    const replayText = textOf(replay);
    const runText = textOf(presentation);
    for (const token of ['no-console', 'naming', 'Status', 'Validated', '10 files']) {
      expect(replayText).toContain(token);
      expect(runText).not.toContain(token);
    }
    // The shared verdict summary line (2 errors -> FAIL) remains present in both.
    expect(runText).toContain('FAIL  (2 Errors, 0 Warnings)');
    expect(replayText).toContain('FAIL  (2 Errors, 0 Warnings)');
  });

  it('the replay adds only the replay header — never the fresh-run footer hint', () => {
    const replayText = textOf(replay);
    // Replay-specific header: the session id + the `replayed (projection)` marker.
    expect(replayText).toContain('FIT_REPLAY');
    expect(replayText).toContain('replayed (projection)');
    // A replay is not a fresh run: the "Use --verbose / report" footer guidance
    // (which presentationToView emits on a non-verbose run) is intentionally
    // absent — confirming the replay projection's render is unchanged (plan
    // Assumption 4).
    expect(replayText).not.toContain('Use --verbose for detailed results');
  });
});

// ---------------------------------------------------------------------------
// 3. run-presentation.ts is UI-free — the contracts→cli-ui edge stays forbidden.
// ---------------------------------------------------------------------------

describe('run-presentation.ts adds no cli-ui (or any UI) edge', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  // packages/cli/src/ui/__tests__ → repo root is five levels up.
  const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');

  it('the contracts-imports-core-only cruiser rule forbids the cli-ui edge (RP-0 Task 0.3)', () => {
    // Read the configured gate directly — the same rule `pnpm lint` enforces.
    const cruiser = readFileSync(join(REPO_ROOT, '.config', 'dependency-cruiser.cjs'), 'utf8');
    // The rule exists and its forbidden `to`-list includes cli-ui, so a render-only
    // contracts type can never silently start importing UI primitives.
    expect(cruiser).toContain("name: 'contracts-imports-core-only'");
    expect(cruiser).toContain("'^packages/cli-ui/'");
  });

  it('the RunPresentation source imports only its sibling currency types (no UI import)', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'packages', 'contracts', 'src', 'run-presentation.ts'),
      'utf8',
    );
    // Every `import` in the module: exactly the two intra-contracts currency
    // modules. No `@opensip-cli/cli-ui`, no `ink`/`react`, no view-model types.
    const importLines = source
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l));
    expect(importLines.length).toBeGreaterThan(0);
    for (const importLine of importLines) {
      expect(importLine).toMatch(/from\s+['"]\.\/(signal-envelope|verbose-detail)\.js['"]/);
    }
    expect(source).not.toContain('@opensip-cli/cli-ui');
    expect(source).not.toMatch(/from\s+['"](ink|react)['"]/);
  });
});
