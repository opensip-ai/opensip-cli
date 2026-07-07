const MAX_PROPERTY_STRING_LENGTH = 500;
const MAX_PROPERTY_ARRAY_ITEMS = 10;
const MAX_PROPERTY_OBJECT_KEYS = 16;
const MAX_PROPERTY_DEPTH = 3;

export type JsonLike =
  string | number | boolean | null | readonly JsonLike[] | { readonly [key: string]: JsonLike };

interface BoundedJson {
  readonly value: JsonLike;
}

type ParentRef =
  | { readonly type: 'array'; readonly output: JsonLike[] }
  | { readonly type: 'object'; readonly output: Record<string, JsonLike>; readonly key: string };

type BoundedFrame =
  | {
      readonly type: 'array';
      readonly items: readonly unknown[];
      readonly output: JsonLike[];
      readonly depth: number;
      index: number;
      readonly parent?: ParentRef;
    }
  | {
      readonly type: 'object';
      readonly entries: readonly (readonly [string, unknown])[];
      readonly output: Record<string, JsonLike>;
      readonly depth: number;
      index: number;
      readonly parent?: ParentRef;
    };

/**
 * Convert untrusted metadata into bounded SARIF-safe JSON.
 *
 * The implementation is iterative rather than recursive so graph cycle checks
 * do not mistake defensive JSON traversal for an architectural dependency loop.
 */
export function boundedJson(value: unknown, depth = 0): JsonLike | undefined {
  return boundedJsonValue(value, depth)?.value;
}

function boundedJsonValue(value: unknown, depth = 0): BoundedJson | undefined {
  const primitive = boundedPrimitive(value);
  if (primitive !== undefined) return primitive;
  const root = boundedContainerFrame(value, depth);
  if (root === undefined) return undefined;

  let result: BoundedJson | undefined;
  const stack: BoundedFrame[] = [root];
  while (stack.length > 0) {
    const frame = stack.at(-1);
    if (frame === undefined) break;
    const child = nextChild(frame);
    if (child !== undefined) {
      appendChildFrameOrValue(frame, child, stack);
      continue;
    }

    stack.pop();
    result = attachCompletedFrame(frame) ?? result;
  }
  return result;
}

function boundedPrimitive(value: unknown): BoundedJson | undefined {
  if (value === null) return { value: null };
  if (typeof value === 'string') return { value: value.slice(0, MAX_PROPERTY_STRING_LENGTH) };
  if (typeof value === 'number') return Number.isFinite(value) ? { value } : undefined;
  if (typeof value === 'boolean') return { value };
  return undefined;
}

function boundedContainerFrame(
  value: unknown,
  depth: number,
  parent?: ParentRef,
): BoundedFrame | undefined {
  if (depth >= MAX_PROPERTY_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.slice(0, MAX_PROPERTY_ARRAY_ITEMS),
      output: [],
      depth,
      index: 0,
      ...(parent === undefined ? {} : { parent }),
    };
  }
  if (typeof value === 'object' && value !== null) {
    return {
      type: 'object',
      entries: Object.entries(value).slice(0, MAX_PROPERTY_OBJECT_KEYS),
      output: {},
      depth,
      index: 0,
      ...(parent === undefined ? {} : { parent }),
    };
  }
  return undefined;
}

function appendChildFrameOrValue(
  frame: BoundedFrame,
  child: { readonly key: string | number; readonly value: unknown },
  stack: BoundedFrame[],
): void {
  const nested = boundedPrimitive(child.value);
  if (nested !== undefined) {
    appendBoundedValue(frame, child.key, nested.value);
    return;
  }
  const childFrame = boundedContainerFrame(
    child.value,
    frame.depth + 1,
    parentRef(frame, child.key),
  );
  if (childFrame !== undefined) stack.push(childFrame);
}

function nextChild(
  frame: BoundedFrame,
): { readonly key: string | number; readonly value: unknown } | undefined {
  if (frame.type === 'array') {
    const value = frame.items[frame.index];
    if (frame.index >= frame.items.length) return undefined;
    const key = frame.index;
    frame.index += 1;
    return { key, value };
  }

  const entry = frame.entries[frame.index];
  if (entry === undefined) return undefined;
  frame.index += 1;
  return { key: entry[0], value: entry[1] };
}

function parentRef(frame: BoundedFrame, key: string | number): ParentRef {
  if (frame.type === 'array') {
    return { type: 'array', output: frame.output };
  }
  return { type: 'object', output: frame.output, key: String(key) };
}

function appendBoundedValue(frame: BoundedFrame, key: string | number, value: JsonLike): void {
  if (frame.type === 'array') {
    frame.output.push(value);
  } else {
    frame.output[String(key)] = value;
  }
}

function appendToParent(parent: ParentRef, value: JsonLike): void {
  if (parent.type === 'array') {
    parent.output.push(value);
  } else {
    parent.output[parent.key] = value;
  }
}

function attachCompletedFrame(frame: BoundedFrame): BoundedJson | undefined {
  const completed = completedFrameValue(frame);
  if (completed === undefined) return undefined;
  if (frame.parent === undefined) return completed;
  appendToParent(frame.parent, completed.value);
  return undefined;
}

function completedFrameValue(frame: BoundedFrame): BoundedJson | undefined {
  if (frame.type === 'array') {
    return frame.output.length > 0 ? { value: frame.output } : undefined;
  }
  return Object.keys(frame.output).length > 0 ? { value: frame.output } : undefined;
}
