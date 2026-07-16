import { decideReportOpen, type OpenReportDecision } from '../open-report.js';

/** Apply the shared browser policy while keeping process probes in the composition root. */
export function decideCurrentReportOpen(opts: {
  readonly openRequested: boolean;
  readonly jsonOutput: boolean;
}): OpenReportDecision {
  return decideReportOpen({
    ...opts,
    stdoutIsTTY: process.stdout.isTTY === true,
    env: process.env,
  });
}
