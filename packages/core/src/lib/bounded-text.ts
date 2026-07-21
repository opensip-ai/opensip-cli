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
  if (buffer.length >= limit) {
    return { value: sliceAvoidingSurrogateSplit(buffer, limit), truncated: true };
  }
  const remaining = limit - buffer.length;
  const text = chunk.toString('utf8');
  if (text.length <= remaining) return { value: buffer + text, truncated: false };
  // M18: do not leave a lone high surrogate at the cut boundary.
  return {
    value: buffer + sliceAvoidingSurrogateSplit(text, remaining),
    truncated: true,
  };
}

/** Slice `text` to at most `maxChars` code units without splitting a surrogate pair. */
function sliceAvoidingSurrogateSplit(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  let end = maxChars;
  // High surrogate at end-1 with no room for its low pair → drop the high.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}
