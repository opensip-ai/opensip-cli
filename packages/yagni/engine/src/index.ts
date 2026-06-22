/**
 * @opensip-cli/yagni — YAGNI reduction audit tool.
 */

export { yagniTool, yagniTool as tool, YAGNI_CONTRACT_VERSION, YAGNI_STABLE_ID } from './tool.js';
export { executeYagni } from './cli/execute-yagni.js';
export type { YagniConfig, YagniGraphMode } from './types/yagni-config.js';
export type { YagniFindingMetadata } from './types/yagni-metadata.js';