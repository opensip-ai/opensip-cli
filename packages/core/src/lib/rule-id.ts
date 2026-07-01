/**
 * Rule-id helpers for tools that stamp Signal.ruleId/source from local slugs.
 */

/** Prefix a local rule slug with a tool namespace, idempotently. */
export function namespacedRuleId(namespace: string, slug: string): string {
  const ns = trimTrailingColons(namespace.trim());
  const local = slug.trim();
  if (ns === '') return local;
  if (local === ns || local.startsWith(`${ns}:`)) return local;
  return `${ns}:${trimLeadingColons(local)}`;
}

function trimTrailingColons(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 58) end -= 1;
  return value.slice(0, end);
}

function trimLeadingColons(value: string): string {
  let start = 0;
  while (start < value.length && value.codePointAt(start) === 58) start += 1;
  return value.slice(start);
}
