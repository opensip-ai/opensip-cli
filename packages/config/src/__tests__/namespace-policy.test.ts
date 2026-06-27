import { describe, expect, it } from 'vitest';

import { partitionUnclaimedNamespaces } from '../namespace-policy.js';

describe('partitionUnclaimedNamespaces', () => {
  it('splits loaded-tool authoring bugs from benign unknown namespaces', () => {
    const result = partitionUnclaimedNamespaces(
      {
        unclaimed: [
          { namespace: 'acme-audit' },
          { namespace: 'no-config-tool' },
          { namespace: 'fitnes', suggestion: 'fitness' },
        ],
      },
      new Set(['no-config-tool']),
    );

    expect(result.toolBugs).toEqual([{ namespace: 'no-config-tool' }]);
    expect(result.benign).toEqual([
      { namespace: 'acme-audit' },
      { namespace: 'fitnes', suggestion: 'fitness' },
    ]);
  });

  it('is pure and leaves empty reports empty', () => {
    expect(partitionUnclaimedNamespaces({ unclaimed: [] }, new Set(['tool']))).toEqual({
      toolBugs: [],
      benign: [],
    });
  });
});
