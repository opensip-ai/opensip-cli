/**
 * LiveRun — presentational shell for tool live views (loading/running/done/error).
 *
 * Pure presentation: no effects, no core/contracts imports. State transitions
 * and the produce() seam live in @opensip-cli/cli-live.
 */

import { liveRunBody } from './live-run-views.js';

import type { LiveRunProps } from './live-run-types.js';
import type React from 'react';

export type {
  LiveRunMeta,
  LiveRunSummaryData,
  LiveRunDoneData,
  LiveRunState,
  LiveRunUi,
  LiveRunHeaderMeta,
  LiveRunProps,
} from './live-run-types.js';

export function LiveRun(props: LiveRunProps): React.ReactElement {
  return liveRunBody(props);
}
