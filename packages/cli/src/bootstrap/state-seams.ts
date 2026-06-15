// @fitness-ignore-file null-safety -- repoFor() returns a freshly constructed ToolStateRepo (never null); the heuristic misreads the fluent .put/.list calls
/**
 * state-seams — the host implementation behind the `ToolCliContext.toolState`
 * grouped seam (ADR-0042): durable keyed JSON persistence over the host-owned
 * `tool_state` table via `ToolStateRepo`. Mirrors `baseline-seams.ts`
 * structurally (lazy datastore resolver; sync SQLite bodies typed Promise so a
 * sync throw still rejects for an awaiting caller).
 */

import { ToolStateRepo, type DataStore } from '@opensip-cli/datastore';

import type { ToolCliContext } from '@opensip-cli/core';

/** Build the `toolState` seam group over a lazy datastore resolver. */
export function buildStateSeams(deps: {
  readonly getDatastore: () => DataStore;
}): ToolCliContext['toolState'] {
  const repoFor = (): ToolStateRepo => new ToolStateRepo(deps.getDatastore());
  return {
    get: (tool, key) => Promise.resolve(repoFor().get(tool, key)),
    put: (tool, key, payload) => {
      repoFor().put(tool, key, payload);
      return Promise.resolve();
    },
    delete: (tool, key) => {
      repoFor().delete(tool, key);
      return Promise.resolve();
    },
    list: (tool) => Promise.resolve(repoFor().list(tool)),
  };
}
