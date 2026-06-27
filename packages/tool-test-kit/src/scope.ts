import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  runWithScope,
  runWithScopeSync,
} from '@opensip-cli/core';

import type { RunScopeOptions } from '@opensip-cli/core';

/** Construct a fresh RunScope with empty registries unless overridden. */
export function makeTestScope(opts: RunScopeOptions = {}): RunScope {
  return new RunScope({
    languages: opts.languages ?? new LanguageRegistry(),
    tools: opts.tools ?? new ToolRegistry(),
    ...opts,
  });
}

/** Run an async test body inside a scope. */
export function withScope<T>(scope: RunScope, fn: () => Promise<T>): Promise<T> {
  return runWithScope(scope, fn);
}

/** Run a synchronous test body inside a scope. */
export function withScopeSync<T>(scope: RunScope, fn: () => T): T {
  return runWithScopeSync(scope, fn);
}
