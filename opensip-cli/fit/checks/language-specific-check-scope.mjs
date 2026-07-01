/**
 * @fileoverview language-specific-check-scope — checks authored inside
 * language-specific first-party packs must declare scope explicitly.
 */
import { defineCheck } from '@opensip-cli/fitness';

const LANGUAGE_CHECK_PACK_RE =
  /(?:^|\/)packages\/fitness\/checks-(?:typescript|python|go|java|cpp|rust)\/src\/.*\.(?:ts|tsx)$/;
const DEFINE_CHECK_BLOCK_RE = /defineCheck\s*\(\s*\{[\s\S]*?^}\);/gm;

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

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

export function analyzeLanguageSpecificCheckScope(content, filePath) {
  const rel = relPath(filePath);
  if (!LANGUAGE_CHECK_PACK_RE.test(rel) || isTestOrFixture(rel)) return [];

  const violations = [];
  DEFINE_CHECK_BLOCK_RE.lastIndex = 0;
  let match;
  while ((match = DEFINE_CHECK_BLOCK_RE.exec(content)) !== null) {
    if (/\bscope\s*:/.test(match[0])) continue;
    violations.push({
      line: lineOf(content, match.index),
      type: 'language-specific-check-scope',
      message: 'Language-specific first-party checks must declare defineCheck.scope.',
      severity: 'error',
      suggestion:
        'Add scope: { languages: [...], concerns: [...] } so target matching is explicit and does not fall back to broad file-cache behavior.',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'fb90c541-193e-4b6d-bc82-16617df9e54b',
    slug: 'language-specific-check-scope',
    description: 'Language-specific first-party checks declare explicit scope',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'checks', 'meta'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeLanguageSpecificCheckScope(content, filePath),
  }),
];
