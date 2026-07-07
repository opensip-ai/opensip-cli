/**
 * @fileoverview Scanner exit-code interpretation (ADR-0091, Phase-0 decision 4).
 *
 * Pure: takes a code + the per-command {@link ScannerExitModel} and returns one
 * of `'ok' | 'findings' | 'fault'`. NEVER throws — it returns data and the
 * caller decides whether to raise a typed error.
 *
 * The sharp edge is gitleaks (and the disambiguation it forces): gitleaks exits
 * `1` for BOTH leaks and an internal `log.Fatal`, so an exit in `findings` is
 * only a findings verdict when the artifact actually parsed. The caller passes
 * `artifactValid: false` when the report file is missing/garbage, which downgrades
 * a `findings` code to a `fault`.
 */

import type { ScannerExitModel } from './types.js';

/** The interpreted verdict of a scanner process exit. */
export type ExitVerdict = 'ok' | 'findings' | 'fault';

export const DEFAULT_EXIT_MODEL: ScannerExitModel = { ok: [0], findings: [1], errorFrom: 2 };

/**
 * Interpret a scanner process exit code against its {@link ScannerExitModel}.
 *
 * - code ∈ `ok` ⇒ `'ok'`.
 * - code ∈ `findings` ⇒ `'findings'`, UNLESS `opts.artifactValid === false`
 *   (the gitleaks disambiguation: exit 1 + missing/garbage report ⇒ `'fault'`).
 *   `artifactValid` left `undefined` is treated as valid (stdout scanners, no
 *   artifact to validate).
 * - code `>= errorFrom` ⇒ `'fault'` (the hard ceiling, checked before the
 *   {@link ScannerExitModel.findingsFromNonzero} reclaim so an analysis-error bit
 *   still faults).
 * - `findingsFromNonzero` + nonzero + below the ceiling + valid artifact ⇒
 *   `'findings'` (bitset/threshold scanners — cargo-deny, spotbugs, cargo-clippy).
 * - any other unmodeled value ⇒ `'fault'`.
 *
 * `ok` is checked before `findings` so an overlap resolves to the cleaner verdict.
 */
export function interpretExit(
  code: number,
  model: ScannerExitModel,
  opts?: { readonly artifactValid?: boolean },
): ExitVerdict {
  const artifactValid = opts?.artifactValid !== false;
  if (model.ok.includes(code)) return 'ok';
  if (model.findings.includes(code)) return artifactValid ? 'findings' : 'fault';
  // Hard ceiling wins over the bitset reclaim: an `error`-class code is a fault
  // even for a `findingsFromNonzero` scanner.
  if (model.errorFrom !== undefined && code >= model.errorFrom) return 'fault';
  if (model.findingsFromNonzero === true && code !== 0 && artifactValid) return 'findings';
  return 'fault';
}
