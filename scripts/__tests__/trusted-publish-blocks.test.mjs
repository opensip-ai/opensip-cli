import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPublishBlocks, publishBlockHasProvenance } from '../lib/trusted-publish-blocks.mjs';

test('trusted publish parser scopes provenance to the publish step', () => {
  const workflow = [
    'name: Release',
    'jobs:',
    '  publish:',
    '    permissions:',
    '      id-token: write',
    '    steps:',
    '      - run: pnpm install --frozen-lockfile',
    '        env:',
    '          NPM_CONFIG_PROVENANCE: true',
    '      - run: npm publish dist/app-1.0.0.tgz --access public',
  ].join('\n');

  const blocks = extractPublishBlocks(workflow);
  assert.equal(blocks.length, 1);
  assert.equal(publishBlockHasProvenance(blocks[0]), false);
});

test('trusted publish parser accepts step-scoped provenance env', () => {
  const workflow = [
    'name: Release',
    'jobs:',
    '  publish:',
    '    permissions:',
    '      id-token: write',
    '    steps:',
    '      - run: pnpm install --frozen-lockfile',
    '      - run: npm publish dist/app-1.0.0.tgz --access public',
    '        env:',
    '          NPM_CONFIG_PROVENANCE: true',
  ].join('\n');

  const blocks = extractPublishBlocks(workflow);
  assert.equal(blocks.length, 1);
  assert.equal(publishBlockHasProvenance(blocks[0]), true);
});
