/**
 * Coverage for loadCliDefaults' defensive catch: when the underlying
 * contracts loader throws (vs. its usual permissive {} return), the wrapper
 * logs a structured `cli.config.unavailable` debug event and falls back to
 * `{}` so the bootstrap never hard-fails on a bad config.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadCliDefaultsFromContracts = vi.fn();

vi.mock('@opensip-tools/contracts', () => ({
  loadCliDefaults: loadCliDefaultsFromContracts,
}));

beforeEach(() => {
  vi.resetModules();
  loadCliDefaultsFromContracts.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadCliDefaults (contracts loader throws)', () => {
  it('returns {} and swallows an Error thrown by the contracts loader', async () => {
    loadCliDefaultsFromContracts.mockImplementation(() => {
      throw new Error('disk on fire');
    });
    const { loadCliDefaults } = await import('../bootstrap/cli-defaults.js');
    expect(loadCliDefaults('/some/dir')).toEqual({});
  });

  it('handles a non-Error throw from the contracts loader', async () => {
    loadCliDefaultsFromContracts.mockImplementation(() => {
      const nonError: unknown = 'plain string failure';
      throw nonError;
    });
    const { loadCliDefaults } = await import('../bootstrap/cli-defaults.js');
    expect(loadCliDefaults('/some/dir', '/explicit/config.yml')).toEqual({});
  });
});
