/**
 * init view-model builder. `viewInit` expresses every InitResult branch as a
 * ViewNode: the inside-existing-project refusal, ambiguous-language refusal, the
 * partial-state report (with a pre-existing-file count summary), the
 * created/re-scaffolded/recovered success headlines, and the scaffold-failure
 * fallback. Driven by input variety and asserted through `renderToText`.
 */

import { renderToText, type Span, type ViewNode } from '@opensip-cli/cli-ui';
import { describe, expect, it } from 'vitest';

import { viewInit } from '../views/init-view.js';

import type {
  InitResult,
  RuntimeAdoptionResult,
  RuntimeAdoptionStatus,
} from '@opensip-cli/contracts';

function result(over: Partial<InitResult>): InitResult {
  return {
    type: 'init',
    cwd: '/proj',
    path: '/proj/opensip-cli.config.yml',
    configFilename: 'opensip-cli.config.yml',
    state: 'pristine',
    created: false,
    ...over,
  } as unknown as InitResult;
}

const text = (r: InitResult): string => renderToText(viewInit(r));

const ADOPTION_BY_STATUS = {
  'not-found': {
    status: 'not-found',
    sourcePreserved: false,
    durationMs: 1,
    reasonCode: 'source-absent',
  },
  promoted: {
    status: 'promoted',
    proofStrength: 'generation-bound',
    sourcePreserved: false,
    sourceRetired: true,
    durationMs: 2,
    reasonCode: 'destination-absent',
  },
  'already-project': {
    status: 'already-project',
    sourcePreserved: false,
    durationMs: 3,
    reasonCode: 'source-absent',
  },
  deduplicated: {
    status: 'deduplicated',
    proofStrength: 'generation-bound',
    sourcePreserved: false,
    sourceRetired: true,
    durationMs: 4,
    reasonCode: 'equivalent',
  },
  'kept-project': {
    status: 'kept-project',
    proofStrength: 'path-only',
    sourcePreserved: false,
    sourceRetired: true,
    durationMs: 5,
  },
  conflict: {
    status: 'conflict',
    proofStrength: 'legacy-unverified',
    sourcePreserved: true,
    durationMs: 6,
    reasonCode: 'divergent',
    nextCommand: 'opensip init --runtime-conflict keep-project',
  },
  busy: {
    status: 'busy',
    durationMs: 7,
    reasonCode: 'lease-busy',
    nextCommand: 'opensip init',
  },
  'recovery-required': {
    status: 'recovery-required',
    durationMs: 8,
    reasonCode: 'operation-interrupted',
    nextCommand: 'opensip init',
  },
  'rolled-back': {
    status: 'rolled-back',
    sourcePreserved: true,
    sourceRetired: false,
    durationMs: 9,
    reasonCode: 'operation-failed',
    nextCommand: 'opensip init',
  },
  'cleanup-pending': {
    status: 'cleanup-pending',
    sourcePreserved: false,
    cleanupPending: true,
    durationMs: 10,
    reasonCode: 'cleanup-pending',
    nextCommand: 'opensip init',
  },
} as const satisfies Record<RuntimeAdoptionStatus, RuntimeAdoptionResult>;

function spans(node: ViewNode): readonly Span[] {
  if (node.kind === 'line') return node.spans;
  if (node.kind === 'group') return node.children.flatMap(spans);
  return [];
}

describe('viewInit — refusals', () => {
  it('renders the inside-existing-project message verbatim (one node per line)', () => {
    const out = text(
      result({
        insideExistingProject: { message: 'line one\nline two' },
      } as Partial<InitResult>),
    );
    expect(out).toContain('line one');
    expect(out).toContain('line two');
  });

  it('renders the language-resolution refusal', () => {
    const out = text(
      result({
        languageResolutionError: { detected: [], message: 'pass --language' },
      } as Partial<InitResult>),
    );
    expect(out).toContain('language not resolved');
    expect(out).toContain('pass --language');
  });

  it('renders legacy ambiguousLanguageError with the same refusal headline', () => {
    const out = text(
      result({
        ambiguousLanguageError: { detected: [], message: 'pass --language' },
      } as Partial<InitResult>),
    );
    expect(out).toContain('language not resolved');
    expect(out).toContain('pass --language');
  });
});

describe('viewInit — partial-state report', () => {
  it('renders each headline state and summarizes pre-existing files without listing them', () => {
    const files = [
      { path: '/proj/opensip-cli/custom.ts', classification: 'custom' as const },
      { path: '/proj/opensip-cli/old.ts', classification: 'stale-scaffolded' as const },
      { path: '/proj/opensip-cli/other.ts', classification: 'scaffolded' as const },
    ];
    const dirOnly = text(
      result({
        partialStateError: {
          state: 'partial-dir-only',
          preExistingFiles: files,
          message: 'partial state',
        },
      }),
    );
    expect(dirOnly).toContain('opensip-cli/ present but');
    expect(dirOnly).toContain('Found 3 file(s) preserved under opensip-cli/.');
    expect(dirOnly).not.toContain('custom.ts');
    expect(dirOnly).not.toContain('(custom)');
    expect(dirOnly).not.toContain('(stale-scaffolded)');
    expect(dirOnly).not.toContain('(scaffolded)');
    expect(dirOnly).toContain('opensip init --keep');

    const cfgOnly = text(
      result({
        partialStateError: {
          state: 'partial-config-only',
          preExistingFiles: [],
          message: 'partial state',
        },
      }),
    );
    expect(cfgOnly).toContain('present but opensip-cli/ missing');

    const full = text(
      result({
        partialStateError: {
          state: 'fully-initialized',
          preExistingFiles: [],
          message: 'partial state',
        },
      }),
    );
    expect(full).toContain('Already initialized');
  });

  it('renders only a count for large pre-existing-file lists', () => {
    const files = Array.from({ length: 45 }, (_, index) => ({
      path: `/proj/opensip-cli/fit/checks/file-${String(index).padStart(2, '0')}.mjs`,
      classification: 'custom' as const,
    }));
    const out = text(
      result({
        partialStateError: {
          state: 'partial-dir-only',
          preExistingFiles: files,
          message: 'partial state',
        },
      }),
    );

    expect(out).toContain('Found 45 file(s) preserved under opensip-cli/.');
    expect(out).not.toContain('opensip-cli/fit/checks/file-39.mjs');
    expect(out).not.toContain('opensip-cli/fit/checks/file-40.mjs');
    expect(out).not.toContain('more file(s) not shown');
  });
});

describe('viewInit — created success', () => {
  it('renders a pristine scaffold with created files, gitignore note, and pre-existing files', () => {
    const out = text(
      result({
        created: true,
        state: 'pristine',
        languages: ['typescript', 'python'],
        createdFiles: ['/proj/opensip-cli.config.yml', '/proj/opensip-cli/fit/checks'],
        gitignoreUpdated: true,
        preExistingFiles: [{ path: '/proj/opensip-cli/keep.ts', classification: 'custom' }],
      }),
    );
    expect(out).toContain('Scaffolded for');
    expect(out).toContain('typescript, python');
    expect(out).toContain('.gitignore');
    expect(out).toContain('Pre-existing files: 1 file(s) preserved under opensip-cli/.');
    expect(out).not.toContain('keep.ts');
    expect(out).toContain('opensip fit --recipe example');
    expect(out).not.toContain('Optional tools for this project');
  });

  it('appends optional tools in result order with exact commands and one shared footer', () => {
    const initResult = result({
      created: true,
      state: 'pristine',
      languages: ['python'],
      optionalTools: [
        {
          id: 'ruff',
          pkg: '@opensip-cli/tool-ruff',
          network: 'local-only',
          languages: ['python'],
          installCommand: 'opensip tools install @opensip-cli/tool-ruff',
          projectInstallCommand: 'opensip tools install @opensip-cli/tool-ruff --project',
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
      ],
    });
    const view = viewInit(initResult);
    const out = renderToText(view);

    expect(out).toContain('Optional tools for this project (not installed):');
    expect(out.indexOf('ruff')).toBeLessThan(out.indexOf('bandit'));
    expect(out.indexOf('bandit')).toBeLessThan(out.indexOf('pip-audit'));
    expect(out).toContain('opensip tools install @opensip-cli/tool-ruff');
    expect(out).toContain('opensip tools install @opensip-cli/tool-bandit');
    expect(out).toContain('opensip tools install @opensip-cli/tool-pip-audit  [networked]');
    expect(
      out.match(/Use --project on tools install for repo-local installation\./gu),
    ).toHaveLength(1);
    expect(out).toContain('Full catalog: opensip tools list --available');
    expect(spans(view).filter((span) => span.text.includes('[networked]'))).toEqual([
      expect.objectContaining({ tone: 'warning' }),
    ]);
  });

  it('omits the optional-tools footer for an explicitly empty list', () => {
    const out = text(
      result({
        created: true,
        state: 'pristine',
        languages: ['python'],
        optionalTools: [],
      }),
    );

    expect(out).not.toContain('Optional tools for this project');
    expect(out).not.toContain('Full catalog:');
  });

  it('renders the re-scaffolded headline and unknown language fallback', () => {
    const out = text(result({ created: true, state: 'fully-initialized' }));
    expect(out).toContain('Re-scaffolded for');
    expect(out).toContain('unknown');
  });

  it('renders the recovered-partial-state headline', () => {
    const out = text(
      result({
        created: true,
        state: 'partial-config-only',
        languages: ['go'],
      }),
    );
    expect(out).toContain('Recovered partial state');
  });
});

describe('viewInit — refresh success', () => {
  it('renders refreshed guidance targets and the partial-config hint', () => {
    const out = text(
      result({
        created: false,
        refreshed: true,
        state: 'partial-config-only',
        gitignoreUpdated: true,
        agentGuidance: {
          changed: true,
          targets: [
            { path: '/proj/AGENTS.md', action: 'updated' },
            { path: '/proj/CLAUDE.md', action: 'skipped', reason: 'missing' },
          ],
        },
      }),
    );
    expect(out).toContain('Already initialized; refreshed OpenSIP agent guidance');
    expect(out).toContain('.gitignore');
    expect(out).toContain('AGENTS.md');
    expect(out).toContain('updated');
    expect(out).toContain('CLAUDE.md');
    expect(out).toContain('missing');
    expect(out).toContain('opensip init --keep');
  });
});

describe('viewInit — runtime evidence adoption', () => {
  it.each([
    ['not-found', 'Evidence adoption: no cache evidence found'],
    ['promoted', 'Evidence adoption: cache evidence promoted'],
    ['already-project', 'Evidence adoption: project evidence already active'],
    ['deduplicated', 'Evidence adoption: equivalent cache evidence retired'],
    ['kept-project', 'Evidence adoption: project evidence kept'],
    ['conflict', 'Evidence adoption blocked by a conflict'],
    ['busy', 'Evidence adoption is busy'],
    ['recovery-required', 'Evidence adoption requires recovery'],
    ['rolled-back', 'Evidence adoption rolled back'],
    ['cleanup-pending', 'Evidence adoption committed; cleanup pending'],
  ] as const)('renders the %s state without the generic scaffold failure', (status, headline) => {
    const adoption: RuntimeAdoptionResult = ADOPTION_BY_STATUS[status];
    const out = text(
      result({
        created: false,
        runtimeAdoption: adoption,
      }),
    );

    expect(out).toContain(headline);
    expect(out).not.toContain('Failed to scaffold');
    if (adoption.nextCommand !== undefined) {
      expect(out).toContain(`Next command: ${adoption.nextCommand}`);
    }
  });

  it.each([
    ['not-found', 'Evidence adoption: no cache evidence found'],
    ['promoted', 'Evidence adoption: cache evidence promoted'],
    ['already-project', 'Evidence adoption: project evidence already active'],
    ['deduplicated', 'Evidence adoption: equivalent cache evidence retired'],
    ['kept-project', 'Evidence adoption: project evidence kept'],
  ] as const)('appends %s evidence details to an authored success', (status, headline) => {
    const out = text(
      result({
        created: true,
        languages: ['typescript'],
        runtimeAdoption: ADOPTION_BY_STATUS[status],
      }),
    );

    expect(out).toContain('Scaffolded for typescript');
    expect(out).toContain(headline);
    expect(out).toContain(`Duration: ${ADOPTION_BY_STATUS[status].durationMs} ms`);
  });

  it('renders unknown source disposition without guessing', () => {
    const out = text(
      result({
        runtimeAdoption: ADOPTION_BY_STATUS['recovery-required'],
      }),
    );

    expect(out).toContain('Source disposition: unknown');
    expect(out).not.toContain('Source disposition: preserved');
    expect(out).not.toContain('Source disposition: not preserved');
  });

  it('renders a source-absent result as having no applicable source disposition', () => {
    const out = text(
      result({
        created: true,
        runtimeAdoption: ADOPTION_BY_STATUS['not-found'],
      }),
    );

    expect(out).toContain('Source disposition: not applicable (no source)');
    expect(out).not.toContain('Source disposition: not preserved');
  });

  it('renders bounded authored counts and source proof details', () => {
    const out = text(
      result({
        created: true,
        runtimeAdoption: {
          ...ADOPTION_BY_STATUS.promoted,
          authored: {
            created: 3,
            replaced: 2,
            deleted: 1,
            preserved: 4,
          },
        },
      }),
    );

    expect(out).toContain('Proof strength: generation-bound');
    expect(out).toContain('Source disposition: not preserved');
    expect(out).toContain('Source retired: yes');
    expect(out).toContain('Authored state: 3 created · 2 replaced · 1 deleted · 4 preserved');
    expect(out).toContain('Reason: destination-absent');
  });

  it('reports committed cleanup as usable authority with operation-owned cleanup only', () => {
    const out = text(
      result({
        created: true,
        runtimeAdoption: ADOPTION_BY_STATUS['cleanup-pending'],
      }),
    );

    expect(out).toContain('Evidence adoption committed; cleanup pending');
    expect(out).toContain(
      'Normal evidence writes are allowed. Only operation-owned cleanup remains.',
    );
    expect(out).toContain('Source disposition: not applicable (no source)');
    expect(out).not.toContain('Source disposition: not preserved');
    expect(out).toContain('Scaffolded for');
    expect(out).not.toContain('Failed to scaffold');
    expect(out).not.toContain('rolled back');
  });

  it('composes refresh output with committed cleanup guidance', () => {
    const out = text(
      result({
        created: false,
        refreshed: true,
        state: 'fully-initialized',
        runtimeAdoption: ADOPTION_BY_STATUS['cleanup-pending'],
      }),
    );

    expect(out).toContain('Already initialized; refreshed OpenSIP agent guidance');
    expect(out).toContain('Evidence adoption committed; cleanup pending');
    expect(out).toContain(
      'Normal evidence writes are allowed. Only operation-owned cleanup remains.',
    );
    expect(out).not.toContain('Failed to scaffold');
  });

  it('retains rolled-back truth while accurately separating pending cleanup', () => {
    const out = text(
      result({
        runtimeAdoption: {
          ...ADOPTION_BY_STATUS['rolled-back'],
          cleanupPending: true,
        },
      }),
    );

    expect(out).toContain('Evidence adoption rolled back; cleanup pending');
    expect(out).toContain(
      'Normal evidence writes are allowed. Only operation-owned cleanup remains.',
    );
    expect(out).not.toContain('The attempted evidence adoption did not commit.');
    expect(out).not.toContain('Failed to scaffold');
  });

  it('does not imply an authored-only rollback deleted cache evidence', () => {
    const out = text(
      result({
        runtimeAdoption: {
          ...ADOPTION_BY_STATUS['rolled-back'],
          sourcePreserved: false,
          sourceRetired: false,
        },
      }),
    );

    expect(out).toContain('Evidence adoption rolled back');
    expect(out).toContain('Source disposition: not applicable (no source)');
    expect(out).not.toContain('Source disposition: not preserved');
    expect(out).not.toContain('Source retired:');
  });

  it('keeps real source-route dispositions distinct from authored-only outcomes', () => {
    const promoted = text(
      result({
        created: true,
        runtimeAdoption: ADOPTION_BY_STATUS.promoted,
      }),
    );
    const rolledBack = text(
      result({
        runtimeAdoption: ADOPTION_BY_STATUS['rolled-back'],
      }),
    );

    expect(promoted).toContain('Source disposition: not preserved');
    expect(promoted).toContain('Source retired: yes');
    expect(rolledBack).toContain('Source disposition: preserved');
    expect(rolledBack).toContain('Source retired: no');
  });

  it('does not disclose non-contract runtime internals or arbitrary exception text', () => {
    const adoption = {
      ...ADOPTION_BY_STATUS['recovery-required'],
      runtimePath: '/Users/customer/private/project/opensip-cli/.runtime',
      manifestDigest: 'secret-manifest-digest',
      ownerToken: 'secret-owner-token',
      journalPath: '/private/runtime-promotion.json',
      message: 'arbitrary internal exception text',
    } as RuntimeAdoptionResult;
    const out = text(result({ runtimeAdoption: adoption }));

    expect(out).not.toMatch(
      /(?:Users\/customer|secret-manifest|secret-owner|runtime-promotion\.json|arbitrary internal)/u,
    );
    expect(out).toContain('Reason: operation-interrupted');
    expect(out).toContain('Next command: opensip init');
  });

  it('uses candidate-neutral conflict guidance for a quarantined weak source', () => {
    const out = text(
      result({
        runtimeAdoption: {
          ...ADOPTION_BY_STATUS.conflict,
          reasonCode: 'weak-source-requires-selection',
          nextCommand: 'opensip init --runtime-conflict use-cache',
        },
      }),
    );

    expect(out).toContain('The cache candidate requires an explicit evidence selection.');
    expect(out).toContain('Next command: opensip init --runtime-conflict use-cache');
    expect(out).not.toContain('between the available evidence authorities');
  });

  it('does not describe non-interruption recovery reasons as interrupted operations', () => {
    const out = text(
      result({
        runtimeAdoption: {
          ...ADOPTION_BY_STATUS['recovery-required'],
          reasonCode: 'artifact-mismatch',
        },
      }),
    );

    expect(out).toContain('Retry Init to reconcile the evidence operation safely.');
    expect(out).not.toContain('interrupted evidence operation');
  });

  it('preserves refusal precedence over an attached adoption result', () => {
    const out = text(
      result({
        insideExistingProject: {
          discoveredRoot: '/proj',
          message: 'refuse before adoption presentation',
        },
        runtimeAdoption: ADOPTION_BY_STATUS.promoted,
      }),
    );

    expect(out).toContain('refuse before adoption presentation');
    expect(out).not.toContain('Evidence adoption');
  });
});

describe('viewInit — failure fallback', () => {
  it('renders the scaffold-failure line when nothing was created and no error branch matched', () => {
    const out = text(result({ created: false }));
    expect(out).toContain('Failed to scaffold');
    expect(out).toContain('opensip-cli.config.yml');
  });
});
