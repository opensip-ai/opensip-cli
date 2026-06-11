import { applyCheckDisplay } from '@opensip-tools/fitness';

import { pythonFunctionTooLong } from './checks/function-too-long.js';
import { noBareExcept } from './checks/no-bare-except.js';
import { checkDisplay } from './display/index.js';

// Display (icon + name) is folded ONTO each check from this pack's `checkDisplay`
// authoring map (§5.3) — display travels on `check.config`, no separate export.
export const checks = applyCheckDisplay([noBareExcept, pythonFunctionTooLong], checkDisplay);
