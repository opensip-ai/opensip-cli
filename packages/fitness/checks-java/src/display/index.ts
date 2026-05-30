/**
 * Display metadata for Java fitness checks.
 *
 * Maps each check slug to its [icon, displayName] tuple for CLI/report
 * rendering. Keys must match the `slug` of the corresponding check.
 */
import type { CheckDisplayEntry } from '@opensip-tools/core';

export const checkDisplay: Readonly<Record<string, CheckDisplayEntry>> = {
  'no-print-stack-trace': ['🧵', 'No printStackTrace'],
};
