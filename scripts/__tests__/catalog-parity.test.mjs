import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findCatalogInvariantIssues,
  findCodeParityIssues,
  findPlaneParityIssues,
  parseGeneratedIndex,
} from '../verify-catalog-parity.mjs';

function catalog(ownerId, codes) {
  const list = codes.map((code) => ({ code, owner: { id: ownerId } }));
  return {
    owner: { id: ownerId },
    list,
    get(code) {
      return list.find((definition) => definition.code === code);
    },
  };
}

function builtRecord(packageName, ownerId, codes) {
  return { packageName, ownerId, catalog: catalog(ownerId, codes) };
}

describe('catalog parity', () => {
  it('names the missing plane and exact package/owner pair', () => {
    const built = [builtRecord('@opensip-cli/output', '@opensip-cli/output', ['OUTPUT.IO.BAD'])];

    assert.deepEqual(findPlaneParityIssues(built, [], 'runtime registration'), [
      'runtime registration missing catalog @opensip-cli/output (owner @opensip-cli/output)',
    ]);
  });

  it('reports owner attribution drift against the built object', () => {
    const built = [
      builtRecord('@opensip-cli/simulation', 'tool-uuid', ['SIMULATION.RECIPE.INVALID']),
    ];
    const indexed = [
      {
        code: 'SIMULATION.RECIPE.INVALID',
        packageName: '@opensip-cli/simulation',
        ownerId: 'simulation',
      },
    ];

    assert.deepEqual(findCodeParityIssues(built, indexed, 'generated index'), [
      'generated index attributes SIMULATION.RECIPE.INVALID to @opensip-cli/simulation (owner simulation); built object owns @opensip-cli/simulation (owner tool-uuid)',
    ]);
  });

  it('detects one owner with two heads, a shared head, and a cross-owner duplicate', () => {
    const records = [
      builtRecord('@example/a', 'owner-a', ['ALPHA.IO.BAD']),
      builtRecord('@example/a', 'owner-a', ['BETA.IO.BAD']),
      builtRecord('@example/b', 'owner-b', ['ALPHA.IO.BAD']),
    ];

    assert.deepEqual(findCatalogInvariantIssues(records), [
      'built owner owner-a claims multiple heads: ALPHA, BETA',
      'built head ALPHA is claimed by multiple owners: owner-a, owner-b',
      'built code ALPHA.IO.BAD is claimed by multiple owners: owner-a, owner-b',
    ]);
  });

  it('reads catalog owner ids and code attribution from the generated index tables', () => {
    const markdown = `# Error code index

## Catalogs

| Package | Owner id | Source file | Count |
|---|---|---|---:|
| \`@example/tool\` | \`stable-tool-id\` | \`src/errors.ts\` | 1 |

## Codes

| Code | Package | Source |
|---|---|---|
| \`EXAMPLE.IO.BAD\` | \`@example/tool\` | application |

## See also
`;

    assert.deepEqual(parseGeneratedIndex(markdown), {
      catalogs: [{ packageName: '@example/tool', ownerId: 'stable-tool-id' }],
      codes: [
        {
          code: 'EXAMPLE.IO.BAD',
          packageName: '@example/tool',
          ownerId: 'stable-tool-id',
        },
      ],
    });
  });
});
