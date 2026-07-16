import { describe, expect, it } from 'vitest';

import { RunScope } from '../../lib/run-scope-class.js';
import {
  createRuntimeCommandInventory,
  DEFAULT_RUNTIME_COMMAND_INVENTORY_LIMITS,
  EMPTY_RUNTIME_COMMAND_INVENTORY,
  MAX_RUNTIME_COMMAND_ALIASES,
  MAX_RUNTIME_COMMAND_GROUPS,
  MAX_RUNTIME_COMMAND_LEAVES,
  MAX_RUNTIME_COMMAND_NAME,
  MAX_RUNTIME_COMMAND_PATH,
  RUNTIME_COMMAND_INVENTORY_VERSION,
  type RuntimeCommandGroup,
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

function group(overrides: Partial<RuntimeCommandGroup> = {}): RuntimeCommandGroup {
  return {
    path: 'tools',
    name: 'tools',
    owner: 'host',
    ownerLabel: 'host',
    visibility: 'public',
    ...overrides,
  };
}

const small = {
  maxLeaves: 4,
  maxGroups: 4,
  maxAliases: 2,
  maxName: 32,
  maxPath: 64,
} as const;

describe('createRuntimeCommandInventory', () => {
  it('returns frozen empty inventory by default constants', () => {
    expect(EMPTY_RUNTIME_COMMAND_INVENTORY.version).toBe(RUNTIME_COMMAND_INVENTORY_VERSION);
    expect(EMPTY_RUNTIME_COMMAND_INVENTORY.leaves).toEqual([]);
    expect(Object.isFrozen(EMPTY_RUNTIME_COMMAND_INVENTORY)).toBe(true);
    expect(DEFAULT_RUNTIME_COMMAND_INVENTORY_LIMITS.maxLeaves).toBe(MAX_RUNTIME_COMMAND_LEAVES);
    expect(MAX_RUNTIME_COMMAND_GROUPS).toBe(1000);
    expect(MAX_RUNTIME_COMMAND_ALIASES).toBe(16);
    expect(MAX_RUNTIME_COMMAND_NAME).toBe(256);
    expect(MAX_RUNTIME_COMMAND_PATH).toBe(1024);
  });

  it('freezes leaves, groups, reasons, and static handlers with optional fields', () => {
    const inv = createRuntimeCommandInventory({
      complete: false,
      reasons: ['third-party-omitted'],
      leaves: [
        leaf({
          path: 'fit list',
          name: 'list',
          aliases: ['ls'],
          provenanceSource: 'bundled',
          packageIdentity: '@opensip-cli/fitness',
          staticHandler: {
            package: '@opensip-cli/fitness',
            path: 'packages/fitness/engine/src/cli/fit/fit-command-spec.ts',
            declaration: 'runFitCommand',
          },
        }),
      ],
      groups: [group()],
    });
    expect(inv.complete).toBe(false);
    expect(inv.reasons).toEqual(['third-party-omitted']);
    expect(Object.isFrozen(inv)).toBe(true);
    expect(Object.isFrozen(inv.leaves)).toBe(true);
    expect(Object.isFrozen(inv.groups)).toBe(true);
    expect(Object.isFrozen(inv.reasons)).toBe(true);
    expect(Object.isFrozen(inv.leaves[0])).toBe(true);
    expect(Object.isFrozen(inv.leaves[0]?.aliases)).toBe(true);
    expect(Object.isFrozen(inv.leaves[0]?.staticHandler)).toBe(true);
    expect(inv.leaves[0]?.provenanceSource).toBe('bundled');
    expect(inv.leaves[0]?.packageIdentity).toBe('@opensip-cli/fitness');
    expect(inv.groups[0]?.path).toBe('tools');
  });

  it('rejects N+1 leaves and groups with injected small limits', () => {
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
    expect(() =>
      createRuntimeCommandInventory(
        {
          groups: [
            group({ path: 'g1', name: 'g1' }),
            group({ path: 'g2', name: 'g2' }),
            group({ path: 'g3', name: 'g3' }),
          ],
        },
        { maxLeaves: 10, maxGroups: 2, maxAliases: 4, maxName: 64, maxPath: 128 },
      ),
    ).toThrow(/maxGroups/);
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

  it('rejects duplicate leaf and group paths', () => {
    expect(() =>
      createRuntimeCommandInventory({
        leaves: [leaf({ path: 'fit' }), leaf({ path: 'fit', name: 'fit2' })],
      }),
    ).toThrow(/duplicate path/);
    expect(() =>
      createRuntimeCommandInventory({
        leaves: [leaf({ path: 'tools' })],
        groups: [group({ path: 'tools' })],
      }),
    ).toThrow(/duplicate path/);
  });

  it('rejects invalid leaf path, name, owner, ownerLabel, visibility, scope, and output', () => {
    expect(() => createRuntimeCommandInventory({ leaves: [leaf({ path: '' })] })).toThrow(
      /path invalid/,
    );
    expect(() =>
      createRuntimeCommandInventory({ leaves: [leaf({ path: 'a'.repeat(2000) })] }),
    ).toThrow(/path invalid/);
    expect(() => createRuntimeCommandInventory({ leaves: [leaf({ name: '' })] })).toThrow(
      /name invalid/,
    );
    expect(() =>
      createRuntimeCommandInventory({ leaves: [leaf({ owner: 'plugin' as 'tool' })] }),
    ).toThrow(/owner must be host\|tool/);
    expect(() => createRuntimeCommandInventory({ leaves: [leaf({ ownerLabel: '' })] })).toThrow(
      /ownerLabel invalid/,
    );
    expect(() =>
      createRuntimeCommandInventory({ leaves: [leaf({ visibility: 'secret' as 'public' })] }),
    ).toThrow(/visibility invalid/);
    expect(() =>
      createRuntimeCommandInventory({ leaves: [leaf({ scope: 'global' as 'project' })] }),
    ).toThrow(/scope invalid/);
    expect(() => createRuntimeCommandInventory({ leaves: [leaf({ output: '' })] })).toThrow(
      /output invalid/,
    );
    expect(() =>
      createRuntimeCommandInventory({ leaves: [leaf({ output: 1 as unknown as string })] }),
    ).toThrow(/output invalid/);
  });

  it('rejects non-object leaves and invalid aliases', () => {
    expect(() =>
      createRuntimeCommandInventory({
        leaves: [null as unknown as RuntimeCommandLeaf],
      }),
    ).toThrow(/plain object/);
    expect(() =>
      createRuntimeCommandInventory({
        leaves: ['not-a-leaf' as unknown as RuntimeCommandLeaf],
      }),
    ).toThrow(/plain object/);
    expect(() =>
      createRuntimeCommandInventory({ leaves: [leaf({ aliases: ['a', 'b', 'c'] })] }, small),
    ).toThrow(/aliases/);
    expect(() =>
      createRuntimeCommandInventory({ leaves: [leaf({ aliases: [1 as unknown as string] })] }),
    ).toThrow(/alias invalid/);
    expect(() => createRuntimeCommandInventory({ leaves: [leaf({ aliases: [''] })] })).toThrow(
      /alias invalid/,
    );
  });

  it('rejects invalid packageIdentity and staticHandler claims', () => {
    expect(() =>
      createRuntimeCommandInventory({
        leaves: [leaf({ packageIdentity: '' })],
      }),
    ).toThrow(/packageIdentity invalid/);
    expect(() =>
      createRuntimeCommandInventory({
        leaves: [
          leaf({
            staticHandler: {
              package: '@opensip-cli/fitness',
              path: '/abs/path.ts',
              declaration: 'run',
            },
          }),
        ],
      }),
    ).toThrow(/staticHandler/);
    expect(() =>
      createRuntimeCommandInventory({
        leaves: [
          leaf({
            staticHandler: {
              package: '@opensip-cli/fitness',
              path: 'packages/x.ts',
              declaration: 'run',
              extra: true,
            } as never,
          }),
        ],
      }),
    ).toThrow(/unknown field/);
  });

  it('rejects invalid groups and reasons', () => {
    expect(() => createRuntimeCommandInventory({ groups: [group({ path: '' })] })).toThrow(
      /group path invalid/,
    );
    expect(() => createRuntimeCommandInventory({ groups: [group({ name: '' })] })).toThrow(
      /group name invalid/,
    );
    expect(() =>
      createRuntimeCommandInventory({ groups: [group({ owner: 'plugin' as 'host' })] }),
    ).toThrow(/group owner/);
    expect(() => createRuntimeCommandInventory({ groups: [group({ ownerLabel: '' })] })).toThrow(
      /group ownerLabel/,
    );
    expect(() =>
      createRuntimeCommandInventory({ groups: [group({ visibility: 'secret' as 'public' })] }),
    ).toThrow(/group visibility/);
    expect(() => createRuntimeCommandInventory({ reasons: [''] })).toThrow(/reason must be/);
    expect(() => createRuntimeCommandInventory({ reasons: [1 as unknown as string] })).toThrow(
      /reason must be/,
    );
  });

  it('accepts host leaves without packageIdentity', () => {
    const inv = createRuntimeCommandInventory({
      leaves: [
        leaf({
          path: 'init',
          name: 'init',
          owner: 'host',
          ownerLabel: 'host',
          scope: 'none',
          output: 'command-result',
          visibility: 'internal',
        }),
      ],
    });
    expect(inv.leaves[0]?.owner).toBe('host');
    expect(inv.leaves[0]?.visibility).toBe('internal');
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
