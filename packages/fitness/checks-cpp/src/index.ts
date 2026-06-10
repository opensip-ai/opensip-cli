import { applyCheckDisplay } from '@opensip-tools/fitness';

import { clangTidyPassthrough } from './checks/clang-tidy-passthrough.js';
import { checkDisplay } from './display/index.js';

// Display (icon + name) is folded ONTO each check from this pack's `checkDisplay`
// authoring map (§5.3) — display travels on `check.config`, no separate export.
export const checks = applyCheckDisplay([clangTidyPassthrough], checkDisplay);
