/**
 * @fileoverview registered-local-allowlists — project-local fitness checks must
 * register source-local allowlist/exemption constants in seam-exemptions.json.
 */
import { defineCheck } from '@opensip-cli/fitness';

import { loadSeamExemptions } from '../../../scripts/load-seam-exemptions.mjs';

const PROJECT_LOCAL_CHECK_RE = /(?:^|\/)opensip-cli\/fit\/checks\/.*\.mjs$/;
const LOCAL_LIST_DECL_RE =
  /const\s+([A-Z0-9_]*(?:ALLOWLIST|ALLOWLISTED|EXEMPT|ALLOWED)[A-Z0-9_]*)\s*=\s*(?:new\s+Set\s*\(|\[|\{|\/)/g;

function relPath(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function registeredLocalAllowlists(manifest) {
  const entries = Array.isArray(manifest.localAllowlists) ? manifest.localAllowlists : [];
  return new Set(
    entries
      .filter(
        (entry) =>
          typeof entry?.file === 'string' &&
          typeof entry.name === 'string' &&
          typeof entry.reason === 'string' &&
          entry.reason.trim().length > 0,
      )
      .map((entry) => `${entry.file}#${entry.name}`),
  );
}

function allowlistKey(filePath, name) {
  const normalized = relPath(filePath);
  const marker = 'opensip-cli/fit/checks/';
  const index = normalized.indexOf(marker);
  const manifestPath = index < 0 ? normalized : normalized.slice(index);
  return `${manifestPath}#${name}`;
}

export function analyzeRegisteredLocalAllowlists(
  content,
  filePath,
  manifest = loadSeamExemptions(),
) {
  const normalized = relPath(filePath);
  if (!PROJECT_LOCAL_CHECK_RE.test(normalized)) return [];

  const registered = registeredLocalAllowlists(manifest);
  const violations = [];
  LOCAL_LIST_DECL_RE.lastIndex = 0;
  let match;
  while ((match = LOCAL_LIST_DECL_RE.exec(content)) !== null) {
    const name = match[1];
    if (registered.has(allowlistKey(normalized, name))) continue;
    violations.push({
      line: lineOf(content, match.index),
      type: 'registered-local-allowlists',
      message: `Local allowlist/exemption '${name}' is not registered in opensip-cli/seam-exemptions.json.`,
      severity: 'error',
      suggestion:
        'Add a localAllowlists entry with file, name, and reason, or route the exemption through the shared seam-exemptions mechanism.',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '58b3c40b-f9f6-4c7a-bdc2-ec2d510c2e7d',
    slug: 'registered-local-allowlists',
    description: 'Project-local fitness-check allowlists are registered with reasons',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'checks', 'meta'],
    fileTypes: ['mjs'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeRegisteredLocalAllowlists(content, filePath),
  }),
];
