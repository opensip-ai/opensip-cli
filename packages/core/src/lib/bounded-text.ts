/** Result of appending a text chunk under a bounded capture limit. */
export interface BoundedTextAppendResult {
  readonly value: string;
  readonly truncated: boolean;
}

/** Append a UTF-8 chunk to a string without exceeding a caller-owned character cap. */
export function appendBoundedUtf8Text(
  buffer: string,
  chunk: Buffer,
  maxLength: number,
): BoundedTextAppendResult {
  const limit = Math.max(0, maxLength);
  if (buffer.length >= limit) return { value: buffer.slice(0, limit), truncated: true };
  const remaining = limit - buffer.length;
  const text = chunk.toString('utf8');
  if (text.length <= remaining) return { value: buffer + text, truncated: false };
  return { value: buffer + text.slice(0, remaining), truncated: true };
}
