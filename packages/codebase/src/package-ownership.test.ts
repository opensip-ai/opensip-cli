import { describe, expect, it } from 'vitest';

import { findOwningPackage } from './package-ownership.js';

import type { PackageFact } from '@opensip-cli/contracts';

function packageFact(name: string, root: string): PackageFact {
  return {
    name,
    root,
    private: false,
    exports: [],
    bins: [],
    verificationCommands: [],
    provenance: [],
  };
}

describe('findOwningPackage', () => {
  it('prefers a one-character package root over the workspace root', () => {
    const workspace = packageFact('workspace', '.');
    const member = packageFact('member', 'a');

    expect(findOwningPackage('a/src/index.ts', [workspace, member])).toBe(member);
  });
});
