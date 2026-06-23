/** Maximum length for a user-visible live-run error message. */
const MAX_ERROR_MESSAGE_LENGTH = 500;

const API_KEY_RE = /\b(?:sk|api)[-_]?[a-z]*[-_]?key[=:]\s*\S+/gi;
const LONG_LINE_RE = /.{200,}/g;

/**
 * Truncate and scrub a producer rejection before it reaches the rendered error
 * frame or a log event (no raw file bodies, no stored API keys).
 */
export function scrubErrorMessage(raw: string): string {
  let message = raw.replace(API_KEY_RE, '[redacted]').replace(LONG_LINE_RE, '[truncated content]');
  if (message.length > MAX_ERROR_MESSAGE_LENGTH) {
    message = `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`;
  }
  return message;
}
