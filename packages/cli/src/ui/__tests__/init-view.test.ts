/**
 * init view-model builder. `viewInit` expresses every InitResult branch as a
 * ViewNode: the inside-existing-project refusal, ambiguous-language refusal, the
 * partial-state report (with each pre-existing-file classification tone), the
 * created/re-scaffolded/recovered success headlines, and the scaffold-failure
 * fallback. Driven by input variety and asserted through `renderToText`.
 */

import { renderToText } from '@opensip-cli/cli-ui';
import { describe, expect, it } from 'vitest';

import { viewInit } from '../views/init-view.js';

import type { InitResult } from '@opensip-cli/contracts';

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

  it('renders the ambiguous-language refusal', () => {
    const out = text(
      result({
        ambiguousLanguageError: { message: 'pass --language' },
      } as Partial<InitResult>),
    );
    expect(out).toContain('language ambiguous');
    expect(out).toContain('pass --language');
  });
});

describe('viewInit — partial-state report', () => {
  it('renders each headline state and every pre-existing-file classification tone', () => {
    const files = [
      { path: '/proj/opensip-cli/custom.ts', classification: 'custom' },
      { path: '/proj/opensip-cli/old.ts', classification: 'stale-scaffolded' },
      { path: '/proj/opensip-cli/other.ts', classification: 'scaffolded' },
    ];
    const dirOnly = text(
      result({
        partialStateError: {
          state: 'partial-dir-only',
          preExistingFiles: files,
        },
      } as Partial<InitResult>),
    );
    expect(dirOnly).toContain('opensip-cli/ present but');
    expect(dirOnly).toContain('(custom)');
    expect(dirOnly).toContain('(stale-scaffolded)');
    expect(dirOnly).toContain('(scaffolded)');
    expect(dirOnly).toContain('opensip init --keep');

    const cfgOnly = text(
      result({
        partialStateError: {
          state: 'partial-config-only',
          preExistingFiles: [],
        },
      } as Partial<InitResult>),
    );
    expect(cfgOnly).toContain('present but opensip-cli/ missing');

    const full = text(
      result({
        partialStateError: { state: 'fully-initialized', preExistingFiles: [] },
      } as Partial<InitResult>),
    );
    expect(full).toContain('Already initialized');
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
    expect(out).toContain('Pre-existing files');
    expect(out).toContain('opensip fit --recipe example');
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

describe('viewInit — failure fallback', () => {
  it('renders the scaffold-failure line when nothing was created and no error branch matched', () => {
    const out = text(result({ created: false }));
    expect(out).toContain('Failed to scaffold');
    expect(out).toContain('opensip-cli.config.yml');
  });
});
