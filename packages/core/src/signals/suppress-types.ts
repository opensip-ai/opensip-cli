/**
 * Shared suppression types — leaf module so `suppress-missing-files.ts` can
 * reference request shapes without importing the full suppress scanner.
 */

import type { Signal } from '../types/signal.js';

/** The two directive keywords a tool owns. */
export interface SuppressionKeywords {
  readonly file: string;
  readonly nextLine: string;
}

/** A candidate source location a directive may target for a given signal. */
export interface SuppressionLocation {
  readonly file: string;
  readonly line?: number;
}

/** Request for {@link filterSignalsBySuppressions}. */
export interface SuppressionRequest {
  readonly signals: readonly Signal[];
  readonly keywords: SuppressionKeywords;
  readonly readFile: (filePath: string) => Promise<string>;
  readonly locate?: (signal: Signal) => readonly SuppressionLocation[];
  readonly ruleIdOf?: (signal: Signal) => string;
}

/** One suppressed signal + the directive that suppressed it. */
export interface SuppressionMatch {
  readonly signal: Signal;
  readonly ruleId: string;
  readonly file: string;
  readonly line: number | 'file';
}

/** Result of {@link filterSignalsBySuppressions}. */
export interface SuppressionResult {
  readonly kept: readonly Signal[];
  readonly suppressed: readonly SuppressionMatch[];
}