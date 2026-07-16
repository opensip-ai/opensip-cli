/**
 * @fileoverview Benchmark-facing re-export of the shared process-tree RSS +
 * termination primitives.
 *
 * The implementation moved to `scripts/lib/measured-process.mjs` so both the
 * benchmarks and platform acceptance share ONE bounded measured-process
 * substrate without acceptance depending on benchmark ownership. This shim keeps
 * every existing `scripts/perf/process-tree-rss.mjs` import stable.
 */

export {
  killProcessTree,
  parseProcessTable,
  processDescendantsFromTable,
  readProcessTable,
  signalCapturedProcesses,
  sumProcessTreeRss,
} from '../lib/measured-process.mjs';
