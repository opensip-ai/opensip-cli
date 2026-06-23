/**
 * Shared https URL validation for credential-bearing cloud egress.
 */

/** True when `url` uses an https scheme (case-insensitive). */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
