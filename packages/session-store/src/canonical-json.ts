/** Serialize an already JSON-parsed value with recursively sorted object keys. */
export function canonicalParsedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalParsedJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalParsedJson(record[key])}`)
    .join(',')}}`;
}
