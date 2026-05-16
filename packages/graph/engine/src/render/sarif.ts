/**
 * SARIF renderer — thin wrapper around @opensip-tools/fitness's
 * SARIF builder per DEC-3.
 *
 * Both fitness and graph sit at the tools/lang peer layer; importing
 * fitness's buildSarifLog is the documented exception (recorded in
 * the dep-cruiser config + Appendix C). The wrapper exists so the
 * future @opensip-tools/sarif extraction is mechanical.
 */

import { buildSarifLog } from '@opensip-tools/fitness';

import type { CliOutput } from '@opensip-tools/contracts';

export function renderSarif(output: CliOutput): string {
  return JSON.stringify(buildSarifLog(output), null, 2);
}

export { chunkSarifRuns, reportToCloud } from '@opensip-tools/fitness';
