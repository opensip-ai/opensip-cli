/**
 * @fileoverview Shared utilities for check authors.
 *
 * These helpers were previously copy-pasted between check packs
 * (@opensip-cli/checks-typescript and @opensip-cli/checks-universal).
 * Both packs depend on @opensip-cli/fitness, so the engine is the
 * natural shared home.
 */

export { isCommentLine } from './source-analysis.js';
export type { IsCommentLineOptions } from './source-analysis.js';

export { isCheckAuthoringSource } from './check-authoring-helpers.js';
export { isTestFile } from './test-helpers.js';
export type { IsTestFileOptions } from './test-helpers.js';

export {
  applyCheckDisplay,
  getCheckDisplayName,
  getCheckIcon,
  makeDisplayHelpers,
} from './display.js';
export type { DisplayHelpers } from './display.js';

export { createPathMatcher } from './path-matching.js';
export type { PathPattern } from './path-matching.js';
