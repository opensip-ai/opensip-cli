import { describe, expect, it } from 'vitest';

import { RunScope } from '../../lib/run-scope-class.js';
import {
  createRuntimeCommandInventory,
  EMPTY_RUNTIME_COMMAND_INVENTORY,
  MAX_RUNTIME_COMMAND_LEAVES,
  RUNTIME_COMMAND_INVENTORY_VERSION,
  type RuntimeCommandLeaf,
} from '../runtime-command-inventory.js';

function leaf(overrides: Partial<RuntimeCommandLeaf> = {}): RuntimeCommandLeaf {
  return {
    path: 'fit',
    name: 'fit',
    aliases: [],
    owner: 'tool',
    ownerLabel: 'fit',
    visibility: 'public',
    scope: 'project',
    output: 'raw-stream',
    ...overrides,
  };
}

describe('createRuntimeCommandInventory', () => {
  it('returns frozen empty inventory by default constants', () => {
    expect(EMPTY_RUNTIME_COMMAND_INVENTORY.version).toBe(RUNTIME_COMMAND_INVENTORY_VERSION);
    expect(EMPTY_RUNTIME_COMMAND_INVENTORY.leaves).toEqual([]);
    expect(Object.isFrozen(EMPTY_RUNTIME_COMMAND_INVENTORY)).toBe(true);
  });

  it('freezes leaves and static handlers', () => {
    const inv = createRuntimeCommandInventory({
      leaves: [
        leaf({
          staticHandler: {
            package: '@opensip-cli/fitness',
            path: 'packages/fitness/engine/src/cli/fit/fit-command-spec.ts',
            declaration: 'runFitCommand',
          },
        }),
      ],
    });
    expect(Object.isFrozen(inv)).toBe(true);
    expect(Object.isFrozen(inv.leaves[0])).toBe(true);
    expect(Object.isFrozen(inv.leaves[0]?.staticHandler)).toBe(true);
  });

  it('rejects N+1 leaves with injected small limits', () => {
    expect(() =>
      createRuntimeCommandInventory(
        {
          leaves: [
            leaf({ path: 'a', name: 'a' }),
            leaf({ path: 'b', name: 'b' }),
            leaf({ path: 'c', name: 'c' }),
          ],
        },
        { maxLeaves: 2, maxGroups: 4, maxAliases: 4, maxName: 64, maxPath: 128 },
      ),
    ).toThrow(/maxLeaves/);
  });

  it('accepts N leaves at injected boundary', () => {
    const inv = createRuntimeCommandInventory(
      {
        leaves: [leaf({ path: 'a', name: 'a' }), leaf({ path: 'b', name: 'b' })],
      },
      { maxLeaves: 2, maxGroups: 4, maxAliases: 4, maxName: 64, maxPath: 128 },
    );
    expect(inv.leaves).toHaveLength(2);
  });

  it('rejects duplicate paths', () => {
    expect(() =>
      createRuntimeCommandInventory({
        leaves: [leaf({ path: 'fit' }), leaf({ path: 'fit', name: 'fit2' })],
      }),
    ).toThrow(/duplicate path/);
  });

  it('rejects alias overflow at injected boundary', () => {
    expect(() =>
      createRuntimeCommandInventory(
        {
          leaves: [leaf({ aliases: ['a', 'b', 'c'] })],
        },
        { maxLeaves: 10, maxGroups: 4, maxAliases: 2, maxName: 64, maxPath: 128 },
      ),
    ).toThrow(/aliases/);
  });

  it('wires production maxLeaves constant', () => {
    expect(MAX_RUNTIME_COMMAND_LEAVES).toBe(2000);
  });
});

describe('RunScope.runtimeCommands', () => {
  it('defaults to empty inventory', () => {
    const scope = new RunScope();
    expect(scope.runtimeCommands).toBe(EMPTY_RUNTIME_COMMAND_INVENTORY);
  });

  it('accepts explicit inventory and isolates per scope', () => {
    const inv = createRuntimeCommandInventory({ leaves: [leaf()] });
    const a = new RunScope({ runtimeCommands: inv });
    const b = new RunScope();
    expect(a.runtimeCommands.leaves).toHaveLength(1);
    expect(b.runtimeCommands.leaves).toHaveLength(0);
  });
});
