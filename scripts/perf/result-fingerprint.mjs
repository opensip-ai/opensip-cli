import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

const VOLATILE_PATHS = new Set([
  'envelope.createdAt',
  'envelope.runId',
  'envelope.signals.*.createdAt',
  'envelope.signals.*.id',
  'envelope.units.*.durationMs',
]);
const SET_VALUED_ARRAY_PATHS = new Set(['envelope.signals', 'envelope.units']);

export function fingerprintStructuredResult(document, options = {}) {
  const roots = corpusRoots(options.corpusRoot);
  const payload = normalizeValue(
    {
      kind: document.kind,
      status: document.status,
      exitCode: document.exitCode,
      envelope: document.envelope,
    },
    roots,
  );
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function corpusRoots(root) {
  if (typeof root !== 'string' || root.length === 0) return [];
  const roots = new Set([root]);
  try {
    roots.add(realpathSync(root));
  } catch {
    // The caller may be comparing a retained result after its corpus was removed.
  }
  return [...roots].sort((left, right) => right.length - left.length);
}

function normalizeValue(value, roots, path = []) {
  if (typeof value === 'string') return normalizeString(value, roots);
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeValue(entry, roots, [...path, '*']));
    if (SET_VALUED_ARRAY_PATHS.has(path.join('.'))) {
      normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return normalized;
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_PATHS.has([...path, key].join('.')))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeValue(entry, roots, [...path, key])]),
  );
}

function normalizeString(value, roots) {
  let normalized = value;
  for (const root of roots) normalized = normalized.split(root).join('<corpus>');
  return normalized;
}
