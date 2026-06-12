import { applyCheckDisplay } from '@opensip-cli/fitness';

import { noFmtPrint } from './checks/no-fmt-print.js';
import { checkDisplay } from './display/index.js';

// Display (icon + name) is folded ONTO each check from this pack's `checkDisplay`
// authoring map (§5.3) — display travels on `check.config`, no separate export.
export const checks = applyCheckDisplay([noFmtPrint], checkDisplay);
