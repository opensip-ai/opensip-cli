/**
 * root-version — bare `opensip --version` detection. The host prints the CLI
 * version for the bare form; a `--version` after a subcommand is that tool's
 * own (handled by decorateToolPrimary's subcommand-local version option).
 */

import { describe, expect, it } from 'vitest';

import { isRootVersionRequest } from '../root-version.js';

describe('isRootVersionRequest', () => {
  it.each([
    [['--version'], true],
    [['-V'], true],
    // Global flags may precede the bare --version (no subcommand yet).
    [['--no-cloud', '--version'], true],
    [['--no-cloud', '-V'], true],
  ])('treats %j as a bare CLI version request', (argv, expected) => {
    expect(isRootVersionRequest(argv)).toBe(expected);
  });

  it.each([
    // A subcommand verb appears before --version -> belongs to the subcommand.
    [['fit', '--version']],
    [['graph', '--no-cloud', '--version']],
    [['sim', '-V']],
    // No version flag at all.
    [['fit', '--json']],
    [[]],
  ])('does NOT treat %j as a bare CLI version request', (argv) => {
    expect(isRootVersionRequest(argv)).toBe(false);
  });
});
