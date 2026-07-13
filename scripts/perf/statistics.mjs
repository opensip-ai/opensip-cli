function normalizedValues(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('values must be a non-empty array');
  }
  const valueCount = values.length;
  if (valueCount === 0) throw new TypeError('values must be a non-empty array');

  const result = Array.from({ length: valueCount });
  for (const index of Array.from({ length: valueCount }, (_unused, itemIndex) => itemIndex)) {
    const value = values[index];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`values[${String(index)}] must be a finite non-negative number`);
    }
    result[index] = value;
  }
  return result;
}

function sortedValues(values) {
  return normalizedValues(values).sort((left, right) => left - right);
}

/** Return the arithmetic median without mutating the caller's sample array. */
export function median(values) {
  const sorted = sortedValues(values);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint];
  const lower = sorted[midpoint - 1];
  const upper = sorted[midpoint];
  return lower + (upper - lower) / 2;
}

/** Return a percentile using the nearest-rank definition (rank = ceil(p / 100 * n)). */
export function nearestRankPercentile(values, percentile) {
  if (typeof percentile !== 'number' || !Number.isFinite(percentile)) {
    throw new TypeError('percentile must be a finite number');
  }
  if (percentile <= 0 || percentile > 100) {
    throw new RangeError('percentile must be greater than 0 and no greater than 100');
  }

  const sorted = sortedValues(values);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[rank - 1];
}
