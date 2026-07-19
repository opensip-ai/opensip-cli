import assert from 'node:assert/strict';
import test from 'node:test';

import { format as formatWithPrettier } from 'prettier';

import prettierConfig from '../../.config/prettier.config.mjs';
import {
  buildCatalog,
  formatTriageMarkdown,
  renderTriageMarkdown,
} from '../catalog-suppressions.mjs';

const TRIAGE_FILEPATH = '.config/suppression-triage.md';

test('suppression triage output is formatted with the repository Prettier configuration', async () => {
  const catalog = buildCatalog();
  catalog.generatedAt = '2026-07-19T00:00:00.000Z';

  const rawMarkdown = renderTriageMarkdown(catalog);
  const expectedMarkdown = await formatWithPrettier(rawMarkdown, {
    ...prettierConfig,
    filepath: TRIAGE_FILEPATH,
    parser: 'markdown',
  });
  const actualMarkdown = await formatTriageMarkdown(catalog);

  assert.notEqual(rawMarkdown, expectedMarkdown);
  assert.equal(actualMarkdown, expectedMarkdown);
  assert.equal(
    await formatWithPrettier(actualMarkdown, {
      ...prettierConfig,
      filepath: TRIAGE_FILEPATH,
      parser: 'markdown',
    }),
    actualMarkdown,
  );
});
