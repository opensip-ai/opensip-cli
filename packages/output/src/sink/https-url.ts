/**
 * Shared https URL validation for credential-bearing cloud egress.
 */

/** True when `url` uses an https scheme (case-insensitive). */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- URL-validation predicate: a malformed URL is a normal "not https" result (false), not an error to log.
    return false;
  }
}
