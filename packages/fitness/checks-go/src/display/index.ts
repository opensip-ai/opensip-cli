/**
 * Display metadata for Go fitness checks.
 *
 * Maps each check slug to its [icon, displayName] tuple for CLI/report
 * rendering. Keys must match the `slug` of the corresponding check.
 */
import type { CheckDisplayEntry } from '@opensip-cli/fitness';

export const checkDisplay: Readonly<Record<string, CheckDisplayEntry>> = {
  'no-fmt-print': ['🖨️', 'No fmt.Print'],
};
