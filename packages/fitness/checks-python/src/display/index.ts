/**
 * Display metadata for Python fitness checks.
 *
 * Maps each check slug to its [icon, displayName] tuple for CLI/report
 * rendering. Keys must match the `slug` of the corresponding check.
 */
import type { CheckDisplayEntry } from '@opensip-tools/fitness';

export const checkDisplay: Readonly<Record<string, CheckDisplayEntry>> = {
  'no-bare-except': ['🐍', 'No Bare Except'],
};
