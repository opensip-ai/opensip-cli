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
 * Every case renders its `presentation` projection (a RunPresentation). The
 * committed goldens pin the current compact default surface (summary + footer,
 * no per-unit table) and the verbose detail surface (detail body + table).
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

import { GOLDEN_CASES } from './golden-fixtures.js';

import type { RunPresentation } from '@opensip-cli/contracts';

const GOLDENS_DIR = join(dirname(fileURLToPath(import.meta.url)), '__goldens__');
const UPDATE = process.env.UPDATE_GOLDENS === '1';

function ttyFrame(result: RunPresentation): string {
  const { lastFrame } = render(<ThemeProvider>{renderToInk(resultToView(result))}</ThemeProvider>);
  return lastFrame() ?? '';
}

function pipeText(result: RunPresentation): string {
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

describe('golden render fixtures (TTY + pipe; fit/sim byte-identity post-migration)', () => {
  for (const testCase of GOLDEN_CASES) {
    it(`renders ${testCase.name} byte-identically to its goldens`, () => {
      const result = testCase.presentation;
      const tty = ttyFrame(result);
      const pipe = pipeText(result);
      expect(tty).toBe(golden(testCase.name, 'tty', tty));
      expect(pipe).toBe(golden(testCase.name, 'pipe', pipe));
    });
  }
});
