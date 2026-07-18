import { describe, expect, it } from 'vitest';

import {
  attachOptionalToolRecommendations,
  isOptionalToolRecommendationEligible,
} from './optional-tools.js';

import type { FirstPartyAdapter } from '../tools/first-party-adapters.generated.js';
import type { InitResult } from '@opensip-cli/contracts';

const CATALOG: readonly FirstPartyAdapter[] = [
  {
    pkg: '@opensip-cli/tool-ast-grep',
    id: 'ast-grep',
    command: 'opensip ast-grep',
    description: 'Polyglot structural search',
    network: 'local-only',
    languages: [],
    aliases: ['sg'],
  },
  {
    pkg: '@opensip-cli/tool-bandit',
    id: 'bandit',
    command: 'opensip bandit',
    description: 'Python security',
    network: 'local-only',
    languages: ['python'],
    aliases: [],
  },
  {
    pkg: '@opensip-cli/tool-golangci-lint',
    id: 'golangci-lint',
    command: 'opensip golangci-lint',
    description: 'Go linting',
    network: 'local-only',
    languages: ['go'],
    aliases: [],
  },
  {
    pkg: '@opensip-cli/tool-pip-audit',
    id: 'pip-audit',
    command: 'opensip pip-audit',
    description: 'Python dependencies',
    network: 'networked',
    languages: ['python'],
    aliases: [],
  },
  {
    pkg: '@opensip-cli/tool-pmd',
    id: 'pmd',
    command: 'opensip pmd',
    description: 'Java analysis',
    network: 'local-only',
    languages: ['java'],
    aliases: [],
  },
];

function init(overrides: Partial<InitResult> = {}): InitResult {
  return {
    type: 'init',
    created: true,
    path: '/project/opensip-cli.config.yml',
    cwd: '/project',
    configFilename: 'opensip-cli.config.yml',
    state: 'pristine',
    languages: ['python'],
    ...overrides,
  };
}

describe('isOptionalToolRecommendationEligible', () => {
  it('accepts only a newly-created pristine result with at least one language', () => {
    expect(isOptionalToolRecommendationEligible(init())).toBe(true);
    for (const candidate of [
      init({ created: false }),
      init({ state: 'fully-initialized' }),
      init({ state: 'partial-config-only' }),
      init({ state: 'partial-dir-only' }),
      init({ languages: [] }),
      init({ languages: undefined }),
      init({
        runtimeAdoption: {
          status: 'cleanup-pending',
          sourcePreserved: false,
          cleanupPending: true,
          durationMs: 1,
          reasonCode: 'cleanup-pending',
          nextCommand: 'opensip init',
        },
      }),
    ]) {
      expect(isOptionalToolRecommendationEligible(candidate)).toBe(false);
    }
  });
});

describe('attachOptionalToolRecommendations', () => {
  it('projects a single language in catalog order with exact install metadata', () => {
    const source = init();
    const enriched = attachOptionalToolRecommendations(source, {
      installedIds: new Set(),
      catalog: CATALOG,
    });

    expect(source).not.toHaveProperty('optionalTools');
    expect(enriched).not.toBe(source);
    expect(enriched.optionalTools).toEqual([
      {
        id: 'ast-grep',
        pkg: '@opensip-cli/tool-ast-grep',
        network: 'local-only',
        languages: [],
        installCommand: 'opensip tools install @opensip-cli/tool-ast-grep',
        projectInstallCommand: 'opensip tools install @opensip-cli/tool-ast-grep --project',
      },
      {
        id: 'bandit',
        pkg: '@opensip-cli/tool-bandit',
        network: 'local-only',
        languages: ['python'],
        installCommand: 'opensip tools install @opensip-cli/tool-bandit',
        projectInstallCommand: 'opensip tools install @opensip-cli/tool-bandit --project',
      },
      {
        id: 'pip-audit',
        pkg: '@opensip-cli/tool-pip-audit',
        network: 'networked',
        languages: ['python'],
        installCommand: 'opensip tools install @opensip-cli/tool-pip-audit',
        projectInstallCommand: 'opensip tools install @opensip-cli/tool-pip-audit --project',
      },
    ]);
  });

  it('forms a stable polyglot union once and omits installed adapters', () => {
    const enriched = attachOptionalToolRecommendations(init({ languages: ['python', 'go'] }), {
      installedIds: new Set(['bandit']),
      catalog: CATALOG,
    });

    expect(enriched.optionalTools?.map((row) => row.id)).toEqual([
      'ast-grep',
      'golangci-lint',
      'pip-audit',
    ]);
  });

  it('keeps the field absent and returns the input when every match is installed', () => {
    const source = init();
    const result = attachOptionalToolRecommendations(source, {
      installedIds: new Set(['ast-grep', 'bandit', 'pip-audit']),
      catalog: CATALOG,
    });

    expect(result).toBe(source);
    expect(result).not.toHaveProperty('optionalTools');
  });

  it.each([
    ['fully initialized', init({ state: 'fully-initialized' })],
    ['config-only recovery', init({ state: 'partial-config-only' })],
    ['directory-only recovery', init({ state: 'partial-dir-only' })],
    ['refresh', init({ created: false, refreshed: true })],
    [
      'inside-project refusal',
      init({
        created: false,
        insideExistingProject: { discoveredRoot: '/parent', message: 'refused' },
      }),
    ],
    [
      'partial-state refusal',
      init({
        created: false,
        partialStateError: {
          state: 'fully-initialized',
          preExistingFiles: [],
          message: 'choose a flag',
        },
      }),
    ],
    [
      'ambiguous language',
      init({
        created: false,
        ambiguousLanguageError: { detected: ['python', 'go'], message: 'choose a language' },
      }),
    ],
    [
      'cleanup pending',
      init({
        runtimeAdoption: {
          status: 'cleanup-pending',
          sourcePreserved: false,
          cleanupPending: true,
          durationMs: 1,
          reasonCode: 'cleanup-pending',
          nextCommand: 'opensip init',
        },
      }),
    ],
    ['failure', init({ created: false, state: undefined, languages: undefined })],
  ])('leaves an ineligible %s result unchanged', (_name, source) => {
    const result = attachOptionalToolRecommendations(source, {
      installedIds: new Set(),
      catalog: CATALOG,
    });

    expect(result).toBe(source);
    expect(result).not.toHaveProperty('optionalTools');
  });
});
