/**
 * @fileoverview Check-authoring source path detection.
 *
 * Fitness check packs (`packages/fitness/checks-*`) intentionally contain
 * literal examples of the patterns their checks detect (regex strings, fixture
 * slugs, semgrep references). Helpers here let checks skip that corpus without
 * per-file suppressions.
 */

/** Paths under first-party fitness check packs. */
const CHECK_AUTHORING_PATH = /packages\/fitness\/checks-[^/]+\//;

/**
 * True when `filePath` lives under a fitness check pack (`checks-typescript`,
 * `checks-universal`, `checks-go`, …).
 */
export function isCheckAuthoringSource(filePath: string): boolean {
  return CHECK_AUTHORING_PATH.test(filePath.replaceAll('\\', '/'));
}
