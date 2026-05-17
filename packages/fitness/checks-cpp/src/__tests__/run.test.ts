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
  it('runs end-to-end against a fake target file (clang-tidy not required)', async () => {
    // No fixture content needed — when clang-tidy is missing, the executor
    // returns an error result after invoking config.command.args(files).
    // When clang-tidy is present, it parses output via parseClangTidyOutput.
    // Either path exercises the args() closure.
    const result = await clangTidyPassthrough.run(process.cwd(), {
      targetFiles: ['/nonexistent/fixture.cpp'],
    });

    expect(result).toBeDefined();
    expect(Array.isArray(result.signals)).toBe(true);
    expect(typeof result.errors).toBe('number');
    expect(typeof result.warnings).toBe('number');
  });

  it('exposes a stable check config (id/slug/tags/analysisMode)', () => {
    expect(clangTidyPassthrough.config.slug).toBe('cpp-clang-tidy');
    expect(clangTidyPassthrough.config.analysisMode).toBe('command');
    expect(clangTidyPassthrough.config.tags).toContain('cpp');
    expect(clangTidyPassthrough.config.scansFiles).toBe(false);
  });
});
