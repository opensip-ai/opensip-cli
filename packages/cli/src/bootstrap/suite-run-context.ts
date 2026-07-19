import { AsyncLocalStorage } from 'node:async_hooks';

import type { HostEvidenceOwnerToken } from './host-evidence-accumulator.js';

export interface SuiteRunContext {
  readonly suiteRunId: string;
  readonly suiteName: string;
  /** Explicit nested evidence owner for atomic suite finalization. */
  readonly evidenceOwner?: HostEvidenceOwnerToken;
}

const suiteContextStorage = new AsyncLocalStorage<SuiteRunContext>();

/** Return the suite context flowing through the current async call tree. */
export function currentSuiteRunContext(): SuiteRunContext | undefined {
  return suiteContextStorage.getStore();
}

/** Run a callback with one immutable suite context. */
export function runWithSuiteRunContext<T>(ctx: SuiteRunContext, fn: () => T): T {
  return suiteContextStorage.run(ctx, fn);
}

/** Project optional suite identity fields onto a staged Session. */
export function suiteSessionFields(): { suiteRunId?: string; suiteName?: string } {
  const suite = currentSuiteRunContext();
  return suite === undefined ? {} : { suiteRunId: suite.suiteRunId, suiteName: suite.suiteName };
}
