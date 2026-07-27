import { StringDecoder } from 'node:string_decoder';

/**
 * Stateful bounded UTF-8 stream capture.
 *
 * Stream chunks split multi-byte UTF-8 sequences at arbitrary byte boundaries;
 * decoding each chunk independently mangles the split character into U+FFFD
 * pairs. The capture owns a `StringDecoder` so partial sequences carry across
 * `append` calls. A trailing incomplete sequence (child killed mid-write) is
 * dropped rather than emitted as a replacement character.
 */
export interface BoundedUtf8Capture {
  /** Decode `chunk` and append under the cap. Excess text is dropped. */
  append(chunk: Buffer): void;
  /** Captured text so far (never exceeds the cap). */
  readonly value: string;
  /** True once any decoded text was dropped by the cap. */
  readonly truncated: boolean;
}

/** Create a capture that keeps at most `maxChars` UTF-16 code units. */
export function createBoundedUtf8Capture(maxChars: number): BoundedUtf8Capture {
  const limit = Math.max(0, maxChars);
  const decoder = new StringDecoder('utf8');
  let value = '';
  let truncated = false;
  return {
    append(chunk: Buffer): void {
      const text = decoder.write(chunk);
      if (text.length === 0) return;
      if (value.length >= limit) {
        truncated = true;
        return;
      }
      const remaining = limit - value.length;
      if (text.length <= remaining) {
        value += text;
        return;
      }
      // M18: do not leave a lone high surrogate at the cut boundary.
      value += sliceAvoidingSurrogateSplit(text, remaining);
      truncated = true;
    },
    get value(): string {
      return value;
    },
    get truncated(): boolean {
      return truncated;
    },
  };
}

/** Slice `text` to at most `maxChars` code units without splitting a surrogate pair. */
export function sliceAvoidingSurrogateSplit(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  let end = maxChars;
  // High surrogate at end-1 with no room for its low pair → drop the high.
  // Must inspect UTF-16 *code units* (not code points): codePointAt at a high
  // surrogate that still has a low twin returns the full astral scalar and would
  // leave a lone high surrogate at the cut (M18).
  const lastUnit = text[end - 1];
  if (lastUnit !== undefined && lastUnit >= '\uD800' && lastUnit <= '\uDBFF') {
    end -= 1;
  }
  return text.slice(0, end);
}
