/**
 * JSON renderer (skeleton; implemented in P4).
 *
 * Serializes a Signal[] (via CliOutput) for machine consumption.
 */

import type { Renderer } from './types.js';

export const renderJson: Renderer = (_signals, _context): string => {
  throw new Error('renderJson: not implemented (Phase P4).');
};
