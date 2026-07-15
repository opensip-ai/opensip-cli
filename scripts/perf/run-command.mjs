/**
 * @fileoverview Benchmark-facing re-export of the shared bounded measured-command
 * runner.
 *
 * The implementation moved to `scripts/lib/measured-process.mjs` so both the
 * benchmarks and platform acceptance share ONE bounded measured-process
 * substrate without acceptance depending on benchmark ownership. `runMeasuredCommand`
 * keeps its historical input/result shape; benchmark callers are unchanged.
 */

export { runMeasuredCommand } from '../lib/measured-process.mjs';
