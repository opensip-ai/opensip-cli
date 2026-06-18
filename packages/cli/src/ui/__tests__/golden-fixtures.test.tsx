/**
 * Golden render fixtures (envelope-first-presentation plan).
 *
 * Captures and asserts byte-identity of fit/sim/graph human-readable output
 * across the *DoneResult → RunPresentation migration. For each representative
 * case (clean / findings / errored / verbose) the result is rendered through
 * BOTH interpreters:
 *   - `renderToInk` + `lastFrame()` (the TTY path — raw frame, ANSI preserved);
 *   - `renderToText` (the pipe/CI path — no ANSI).
 *
 * The rendered output is committed under `__goldens__/<case>.{tty,pipe}.txt`.
 *
 * RP-0 captures these from the pre-migration `legacyResult` projection (the
 * unmodified `fit-done`/`sim-done`/`graph-done` render path). RP-1 flips the
 * fit/sim cases to render the `presentation` projection (a RunPresentation) and
 * asserts the output is byte-identical to the SAME committed goldens — the
 * migration must not change a single byte for fit/sim. (Graph's output is
 * intended to change in RP-2; its goldens stay the RP-0 baseline RP-2 diffs
 * against, never an equality target.)
 *
 * Regenerate after an intentional change:
 *   UPDATE_GOLDENS=1 pnpm --filter=opensip-cli test golden-fixtures
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToText, renderToInk, ThemeProvider } from '@opensip-cli/cli-ui';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { resultToView } from '../result-to-view.js';

import { GOLDEN_CASES, type GoldenCase } from './golden-fixtures.js';

import type { CommandResult } from '@opensip-cli/contracts';

const GOLDENS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__goldens__');
const UPDATE = process.env.UPDATE_GOLDENS === '1';

function ttyFrame(result: CommandResult): string {
  const { lastFrame } = render(<ThemeProvider>{renderToInk(resultToView(result))}</ThemeProvider>);
  return lastFrame() ?? '';
}

function pipeText(result: CommandResult): string {
  return renderToText(resultToView(result));
}

function goldenPath(name: string, mode: 'tty' | 'pipe'): string {
  return join(GOLDENS_DIR, `${name}.${mode}.txt`);
}

/** Read a committed golden, or write+seed it under UPDATE_GOLDENS. */
function golden(name: string, mode: 'tty' | 'pipe', actual: string): string {
  const path = goldenPath(name, mode);
  if (UPDATE || !existsSync(path)) {
    mkdirSync(GOLDENS_DIR, { recursive: true });
    writeFileSync(path, actual, 'utf8');
    return actual;
  }
  return readFileSync(path, 'utf8');
}

/**
 * RP-0: render the LEGACY projection (the pre-migration CommandResult). This is
 * the capture path; RP-1 re-points fit/sim to the `presentation` projection.
 */
function renderProjection(testCase: GoldenCase): CommandResult {
  return testCase.legacyResult;
}

describe('golden render fixtures (TTY + pipe, pre-migration baseline)', () => {
  for (const testCase of GOLDEN_CASES) {
    it(`renders ${testCase.name} byte-identically to its goldens`, () => {
      const result = renderProjection(testCase);
      const tty = ttyFrame(result);
      const pipe = pipeText(result);
      expect(tty).toBe(golden(testCase.name, 'tty', tty));
      expect(pipe).toBe(golden(testCase.name, 'pipe', pipe));
    });
  }
});
