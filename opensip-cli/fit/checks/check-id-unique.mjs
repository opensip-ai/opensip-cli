/**
 * @fileoverview check-id-unique — first-party check definitions must not reuse
 * a real UUID across distinct defineCheck call sites.
 */
import { defineCheck } from '@opensip-cli/fitness';

const DEFINE_CHECK_ID_RE =
  /defineCheck\s*\(\s*\{[\s\S]*?\bid\s*:\s*['"]([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})['"]/gi;

function relPath(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

function isTestOrFixture(filePath) {
  const rel = relPath(filePath);
  return (
    /\/__tests__\//.test(rel) ||
    /\/__fixtures__\//.test(rel) ||
    /\/fixtures?\//.test(rel) ||
    /\.test\.tsx?$/.test(rel)
  );
}

function isCheckAuthoringFile(filePath) {
  const rel = relPath(filePath);
  return (
    /(?:^|\/)packages\/fitness\/checks-[^/]+\/src\/.*\.(?:ts|tsx)$/.test(rel) ||
    /(?:^|\/)opensip-cli\/fit\/checks\/.*\.mjs$/.test(rel)
  );
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function displayLocation(occurrence) {
  return `${relPath(occurrence.filePath)}:${String(occurrence.line)}`;
}

function defineCheckIds(content, filePath) {
  const occurrences = [];
  DEFINE_CHECK_ID_RE.lastIndex = 0;
  let match;
  while ((match = DEFINE_CHECK_ID_RE.exec(content)) !== null) {
    occurrences.push({
      id: match[1].toLowerCase(),
      filePath,
      line: lineOf(content, match.index),
    });
  }
  return occurrences;
}

export async function analyzeAllCheckIdUnique(files) {
  const candidates = files.paths.filter(
    (path) => isCheckAuthoringFile(path) && !isTestOrFixture(path),
  );
  const contents = await files.readMany(candidates);
  const byId = new Map();

  for (const [filePath, content] of contents) {
    for (const occurrence of defineCheckIds(content, filePath)) {
      const existing = byId.get(occurrence.id) ?? [];
      existing.push(occurrence);
      byId.set(occurrence.id, existing);
    }
  }

  const violations = [];
  for (const [id, occurrences] of byId) {
    if (occurrences.length < 2) continue;
    const locations = occurrences.map(displayLocation).join(', ');
    for (const occurrence of occurrences) {
      violations.push({
        filePath: occurrence.filePath,
        line: occurrence.line,
        type: 'check-id-unique',
        message: `Check ID '${id}' is reused by multiple defineCheck call sites: ${locations}.`,
        severity: 'error',
        suggestion:
          'Generate a new stable UUID for each distinct check. Reusing IDs is only safe for repeated imports of the same physical check, not separate source definitions.',
      });
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'd30d8dcc-48a4-4eb3-befa-fb88ae429caa',
    slug: 'check-id-unique',
    description: 'First-party defineCheck call sites must not reuse check UUIDs',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'checks', 'meta'],
    fileTypes: ['ts', 'tsx', 'mjs'],
    contentFilter: 'raw',
    analyzeAll: analyzeAllCheckIdUnique,
  }),
];
