// @fitness-ignore-file shipped-checks-must-be-generic -- opensip-internal dogfood check (plan 09 Task 8.7): keyed to @opensip-cli workspace specifiers; inert for adopters.
/**
 * @fileoverview No full-replacement `vi.mock` of workspace packages.
 *
 * A `vi.mock('@opensip-cli/<pkg>', () => ({ ... }))` factory that does not
 * spread `importOriginal` replaces EVERY other export of the mocked package
 * with `undefined`. On a high-churn shared package that is a drift trap: a
 * consumer's defensive fallback can silently absorb the `undefined` and the
 * test stays green while the real wiring is broken. The partial form
 * `async (importOriginal) => ({ ...(await importOriginal()), override })`
 * keeps the package surface real and overrides only the seam under test.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const TEST_FILE = /(?:\.test\.tsx?$|\/__tests__\/)/;

/** A `vi.mock('<workspace pkg>', <factory>` head with its content offset. */
const WORKSPACE_VI_MOCK = /vi\.mock\(\s*['"](@opensip-cli\/[^'"]+)['"]\s*,/g;

/**
 * Window after the factory's opening in which the `importOriginal` parameter
 * conventionally appears (it is the factory's parameter, so it sits within
 * the first line of the factory).
 */
const IMPORT_ORIGINAL_WINDOW = 220;

export function analyzeNoFullReplacementViMock(
  content: string,
  filePath: string,
): CheckViolation[] {
  const normalized = filePath.replaceAll('\\', '/');
  if (!TEST_FILE.test(normalized) || normalized.includes('/__fixtures__/')) return [];
  const violations: CheckViolation[] = [];
  for (const match of content.matchAll(WORKSPACE_VI_MOCK)) {
    const window = content.slice(
      match.index,
      match.index + match[0].length + IMPORT_ORIGINAL_WINDOW,
    );
    if (window.includes('importOriginal')) continue;
    const line = content.slice(0, match.index).split('\n').length;
    violations.push({
      line,
      filePath,
      message:
        `Full-replacement vi.mock of workspace package '${match[1] ?? ''}' — every ` +
        'unlisted export becomes undefined, so a defensive fallback can silently ' +
        'absorb real drift and stay green.',
      severity: 'error',
      suggestion:
        "Use the partial form: vi.mock('" +
        (match[1] ?? '') +
        "', async (importOriginal) => ({ ...(await importOriginal()), <override> })).",
      type: 'full-replacement-vi-mock',
    });
  }
  return violations;
}

export const noFullReplacementViMock = defineCheck({
  id: '5f1c3f74-9a1e-4d24-9a71-3f7d8f1c2b90',
  slug: 'no-full-replacement-vi-mock',
  description:
    'Test files must not full-replace a @opensip-cli workspace package with a vi.mock factory that drops importOriginal',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'testing'],
  fileTypes: ['ts', 'tsx'],
  contentFilter: 'raw',
  analyze: (content, filePath) => analyzeNoFullReplacementViMock(content, filePath),
});
