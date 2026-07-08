/**
 * Contract: the host static-render seam (`renderResult`) is embedded-render aware,
 * so a suite step's own output is suppressed WITHOUT any per-tool cooperation.
 *
 * Together with the headless `runToolLiveView` (cli-live), this covers BOTH host
 * render seams every tool funnels through (only-documented-toolcli-seams,
 * ADR-0051) — so a bundled tool, a `tool-*` adapter, or a brand-new customer tool
 * all run headless-in-suite for free, with zero rendering code of their own.
 */

import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  runEmbeddedRender,
  runWithScope,
} from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderResult } from '../render.js';

import type { CommandResult } from '@opensip-cli/contracts';

function scope(): RunScope {
  return new RunScope({
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
    runId: 'RUN_render_embedded_test',
  });
}

// A minimal result that the static path renders as text (any tool result would do).
const RESULT: CommandResult = { type: 'help' };

describe('renderResult embedded-render suppression (free-for-all-tools contract)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders normally when NOT embedded (a standalone run)', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runWithScope(scope(), () => renderResult(RESULT));
    expect(write).toHaveBeenCalled();
  });

  it('writes NOTHING when embedded (a suite step) — the host owns the visible output', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runWithScope(scope(), () => runEmbeddedRender(() => renderResult(RESULT)));
    expect(write).not.toHaveBeenCalled();
  });
});
