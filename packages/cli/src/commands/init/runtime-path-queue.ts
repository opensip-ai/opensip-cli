/** Minimal bytewise min-heap used by the bounded runtime manifest walker. */

export interface RuntimePathQueueEntry {
  readonly relativePath: string;
  readonly absolutePath: string;
}

interface HeapEntry {
  readonly value: RuntimePathQueueEntry;
  readonly key: Buffer;
}

function compare(left: HeapEntry, right: HeapEntry): number {
  return Buffer.compare(left.key, right.key);
}

function swap(values: HeapEntry[], left: number, right: number): void {
  const leftValue = values[left];
  const rightValue = values[right];
  if (leftValue === undefined || rightValue === undefined) return;
  values[left] = rightValue;
  values[right] = leftValue;
}

export class RuntimePathQueue {
  readonly #values: HeapEntry[] = [];

  constructor(initial: readonly RuntimePathQueueEntry[]) {
    for (const entry of initial) this.push(entry);
  }

  push(entry: RuntimePathQueueEntry): void {
    const heapEntry = {
      value: entry,
      key: Buffer.from(entry.relativePath, 'utf8'),
    };
    this.#values.push(heapEntry);
    let index = this.#values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = this.#values[parent];
      if (parentValue === undefined || compare(parentValue, heapEntry) <= 0) break;
      swap(this.#values, parent, index);
      index = parent;
    }
  }

  pop(): RuntimePathQueueEntry | undefined {
    const first = this.#values[0];
    const last = this.#values.pop();
    if (first === undefined || last === undefined || this.#values.length === 0) {
      return first?.value;
    }
    this.#values[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      const smallestValue = this.#values[smallest];
      const leftValue = this.#values[left];
      const rightValue = this.#values[right];
      if (smallestValue === undefined) break;
      if (leftValue !== undefined && compare(leftValue, smallestValue) < 0) smallest = left;
      const candidate = this.#values[smallest];
      if (
        rightValue !== undefined &&
        candidate !== undefined &&
        compare(rightValue, candidate) < 0
      ) {
        smallest = right;
      }
      if (smallest === index) break;
      swap(this.#values, index, smallest);
      index = smallest;
    }
    return first.value;
  }
}
