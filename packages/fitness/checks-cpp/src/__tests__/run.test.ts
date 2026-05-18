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
  // Bumped from the 5 s vitest default. On CI runners clang-tidy may
  // be installed and slow to start (cold spawn + system-header scans
  // against missing TUs); on dev hosts it's typically absent and
  // returns ENOENT immediately. The 20 s window covers both. The
  // check itself caps at 30 s via clangTidyPassthrough.config.timeout
  // so a runaway invocation can't hang indefinitely.
  it('runs end-to-end against a fake target file (clang-tidy not required)', async () => {
    // No fixture content needed — when clang-tidy is missing, the executor
    // returns an error result after invoking config.command.args(files).
    // When clang-tidy is present, it parses output via parseClangTidyOutput.
    // Either path exercises the args() closure.
    const controller = new AbortController();
    // Belt-and-braces: abort the run if it somehow lingers near the
    // test deadline. The 15 s ceiling stays safely under the 20 s
    // testTimeout below.
    const guard = setTimeout(() => { controller.abort(); }, 15_000);
    try {
      const result = await clangTidyPassthrough.run(process.cwd(), {
        targetFiles: ['/nonexistent/fixture.cpp'],
        signal: controller.signal,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.signals)).toBe(true);
      expect(typeof result.errors).toBe('number');
      expect(typeof result.warnings).toBe('number');
    } finally {
      clearTimeout(guard);
    }
  }, 20_000);

  it('exposes a stable check config (id/slug/tags/analysisMode)', () => {
    expect(clangTidyPassthrough.config.slug).toBe('cpp-clang-tidy');
    expect(clangTidyPassthrough.config.analysisMode).toBe('command');
    expect(clangTidyPassthrough.config.tags).toContain('cpp');
    expect(clangTidyPassthrough.config.scansFiles).toBe(false);
  });
});
