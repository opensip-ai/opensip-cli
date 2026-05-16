/**
 * SARIF renderer (skeleton; implemented in P6 per DEC-3).
 *
 * Per DEC-3 / DRY-1, this delegates to @opensip-tools/fitness's
 * `buildSarifLog`. The wrapper is intentionally thin so a future
 * extraction to @opensip-tools/sarif is mechanical.
 */

import type { CliOutput } from '@opensip-tools/contracts';

export function renderSarif(_output: CliOutput): string {
  throw new Error('renderSarif: not implemented (Phase P6).');
}
