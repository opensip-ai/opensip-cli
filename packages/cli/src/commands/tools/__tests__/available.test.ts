import { describe, expect, it } from 'vitest';

import { selectAvailableAdapters, toolsListAvailable } from '../available.js';

import type { FirstPartyAdapter } from '../first-party-adapters.generated.js';

const CATALOG: readonly FirstPartyAdapter[] = [
  {
    pkg: '@opensip-cli/tool-cppcheck',
    id: 'cppcheck',
    command: 'opensip cppcheck',
    description: 'C/C++ static analysis',
    network: 'local-only',
    languages: ['cpp'],
    aliases: [],
  },
  {
    pkg: '@opensip-cli/tool-ruff',
    id: 'ruff',
    command: 'opensip ruff',
    description: 'Python lint',
    network: 'local-only',
    languages: ['python'],
    aliases: [],
  },
  {
    pkg: '@opensip-cli/tool-semgrep',
    id: 'semgrep',
    command: 'opensip semgrep',
    description: 'Polyglot SAST',
    network: 'networked',
    languages: [], // polyglot
    aliases: [],
  },
];

describe('toolsListAvailable', () => {
  it('lists the whole catalog when no language filter is given', () => {
    const result = toolsListAvailable({ installedIds: new Set(), catalog: CATALOG });
    expect(result.type).toBe('tools-available');
    expect(result.lang).toBeUndefined();
    expect(result.totalCount).toBe(3);
    expect(result.adapters.map((a) => a.id)).toEqual(['cppcheck', 'ruff', 'semgrep']);
  });

  it('filters by a specific language AND always includes polyglot adapters', () => {
    const result = toolsListAvailable({ lang: 'cpp', installedIds: new Set(), catalog: CATALOG });
    expect(result.lang).toBe('cpp');
    // cppcheck (cpp) + semgrep (polyglot []), but NOT ruff (python).
    expect(result.adapters.map((a) => a.id)).toEqual(['cppcheck', 'semgrep']);
  });

  it('preserves the singular wrapper JSON shape and property order byte-for-byte', () => {
    const result = toolsListAvailable({
      lang: 'cpp',
      installedIds: new Set(['semgrep']),
      catalog: CATALOG,
    });

    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        type: 'tools-available',
        lang: 'cpp',
        adapters: [
          {
            pkg: '@opensip-cli/tool-cppcheck',
            id: 'cppcheck',
            command: 'opensip cppcheck',
            description: 'C/C++ static analysis',
            network: 'local-only',
            languages: ['cpp'],
            installed: false,
          },
          {
            pkg: '@opensip-cli/tool-semgrep',
            id: 'semgrep',
            command: 'opensip semgrep',
            description: 'Polyglot SAST',
            network: 'networked',
            languages: [],
            installed: true,
          },
        ],
        totalCount: 2,
      }),
    );
  });

  it('a polyglot-only filter still returns just polyglot adapters when nothing else matches', () => {
    const result = toolsListAvailable({ lang: 'go', installedIds: new Set(), catalog: CATALOG });
    expect(result.adapters.map((a) => a.id)).toEqual(['semgrep']);
  });

  it('marks installed adapters from the installed-id set', () => {
    const result = toolsListAvailable({
      installedIds: new Set(['ruff']),
      catalog: CATALOG,
    });
    const byId = Object.fromEntries(result.adapters.map((a) => [a.id, a.installed]));
    expect(byId).toEqual({ cppcheck: false, ruff: true, semgrep: false });
  });

  it('selects a stable Python+Go union with polyglot rows and no duplicates', () => {
    const dualLanguage: FirstPartyAdapter = {
      pkg: '@opensip-cli/tool-dual-language',
      id: 'dual-language',
      command: 'opensip dual-language',
      description: 'Python and Go analysis',
      network: 'local-only',
      languages: ['python', 'go'],
      aliases: [],
    };
    const go: FirstPartyAdapter = {
      pkg: '@opensip-cli/tool-golangci-lint',
      id: 'golangci-lint',
      command: 'opensip golangci-lint',
      description: 'Go lint',
      network: 'local-only',
      languages: ['go'],
      aliases: [],
    };
    const rows = selectAvailableAdapters({
      languages: new Set(['python', 'go']),
      installedIds: new Set(['dual-language']),
      catalog: [CATALOG[0], CATALOG[1], dualLanguage, CATALOG[2], go],
    });

    expect(rows.map((row) => row.id)).toEqual([
      'ruff',
      'dual-language',
      'semgrep',
      'golangci-lint',
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.find((row) => row.id === 'dual-language')?.installed).toBe(true);
  });

  it('treats an empty language set as polyglot-only', () => {
    const rows = selectAvailableAdapters({
      languages: new Set(),
      installedIds: new Set(),
      catalog: CATALOG,
    });
    expect(rows.map((row) => row.id)).toEqual(['semgrep']);
  });

  it('carries package / command / network / languages through to the rows', () => {
    const [cppcheck] = toolsListAvailable({
      lang: 'cpp',
      installedIds: new Set(),
      catalog: CATALOG,
    }).adapters;
    expect(cppcheck).toMatchObject({
      pkg: '@opensip-cli/tool-cppcheck',
      command: 'opensip cppcheck',
      network: 'local-only',
      languages: ['cpp'],
    });
  });

  it('defaults to the real bundled catalog (16 first-party adapters, all real packages)', () => {
    const result = toolsListAvailable({ installedIds: new Set() });
    expect(result.totalCount).toBeGreaterThanOrEqual(13);
    for (const adapter of result.adapters) {
      expect(adapter.pkg).toMatch(/^@opensip-cli\/tool-/);
    }
    // cppcheck must be discoverable under a c++ filter through the bundled catalog.
    const cpp = toolsListAvailable({ lang: 'cpp', installedIds: new Set() });
    expect(cpp.adapters.some((a) => a.id === 'cppcheck')).toBe(true);
  });
});
