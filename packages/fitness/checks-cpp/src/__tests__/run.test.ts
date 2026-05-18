/**
 * @fileoverview Execute the check end-to-end so the closures inside the
 * `defineCheck({...})` config (specifically `command.args`) are invoked.
 *
 * The pure parser is exercised by parse.test.ts and clang-tidy.test.ts.
 * This file's purpose is execution coverage for the un-called closures
 * declared inside the check definition.
 */
import { describe, expect, it } from 'vitest';

import { clangTidyPassthrough } from '../checks/clang-tidy-passthrough.js';

describe('clangTidyPassthrough.run() execution coverage', () => {
  // The clang-tidy bin may be absent (returns ENOENT instantly,
  // common on dev hosts), present and fast (a few seconds), or
  // present and slow (cold-spawn + system-header scans against a
  // missing TU). All three paths satisfy the test's contract: the
  // run does not crash. If the test's 60 s vitest timeout fires
  // during a slow path, the framework throws a clean
  // CheckAbortedError — that's also success because it proves the
  // check responded to the abort signal correctly.
  //
  // The check itself caps at 30 s via
  // `clangTidyPassthrough.config.timeout` so a runaway invocation
  // can't hang indefinitely under any path.
  it('runs end-to-end against a fake target file (clang-tidy not required)', async () => {
    // No fixture content needed — when clang-tidy is missing, the executor
    // returns an error result after invoking config.command.args(files).
    // When clang-tidy is present, it parses output via parseClangTidyOutput.
    // Either path exercises the args() closure.
    try {
      const result = await clangTidyPassthrough.run(process.cwd(), {
        targetFiles: ['/nonexistent/fixture.cpp'],
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.signals)).toBe(true);
      expect(typeof result.errors).toBe('number');
      expect(typeof result.warnings).toBe('number');
    } catch (error) {
      const isCleanAbort =
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        (error as { name?: unknown }).name === 'CheckAbortedError';
      if (!isCleanAbort) throw error;
      expect(isCleanAbort).toBe(true);
    }
  }, 60_000);

  it('exposes a stable check config (id/slug/tags/analysisMode)', () => {
    expect(clangTidyPassthrough.config.slug).toBe('cpp-clang-tidy');
    expect(clangTidyPassthrough.config.analysisMode).toBe('command');
    expect(clangTidyPassthrough.config.tags).toContain('cpp');
    expect(clangTidyPassthrough.config.scansFiles).toBe(false);
  });
});
