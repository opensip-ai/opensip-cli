import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { InitFeedback } from '../../../ui/components/InitFeedback.js';

describe('InitFeedback', () => {
  it('renders the insideExistingProject message verbatim', () => {
    const { lastFrame } = render(
      <InitFeedback
        created={false}
        path="/x/cfg.yml"
        cwd="/x"
        configFilename="opensip-tools.config.yml"
        insideExistingProject={{ discoveredRoot: '/x/parent', message: 'You are inside an existing project at /x/parent' }}
      />,
    );
    expect(lastFrame()).toContain('You are inside an existing project at /x/parent');
  });

  it('renders the ambiguous-language error block', () => {
    const { lastFrame } = render(
      <InitFeedback
        created={false}
        path="/x/cfg.yml"
        cwd="/x"
        configFilename="opensip-tools.config.yml"
        ambiguousLanguageError={{ detected: ['python', 'go'], message: 'Use --language to pick one' }}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Cannot scaffold');
    expect(out).toContain('Use --language to pick one');
  });

  it('renders the partial-state error with pre-existing file list', () => {
    const { lastFrame } = render(
      <InitFeedback
        created={false}
        path="/x/opensip-tools.config.yml"
        cwd="/x"
        configFilename="opensip-tools.config.yml"
        partialStateError={{
          state: 'partial-dir-only',
          preExistingFiles: [
            { path: '/x/opensip-tools/fit/checks/a.mjs', classification: 'scaffolded' },
            { path: '/x/opensip-tools/sim/scenarios/b.mjs', classification: 'custom' },
            { path: '/x/opensip-tools/notes.md', classification: 'stale-scaffolded' },
          ],
          message: 'Partial init detected',
        }}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('opensip-tools/ present but opensip-tools.config.yml missing');
    expect(out).toContain('opensip-tools/fit/checks/a.mjs');
    expect(out).toContain('(scaffolded)');
    expect(out).toContain('(custom)');
    expect(out).toContain('(stale-scaffolded)');
    expect(out).toContain('--keep');
    expect(out).toContain('--remove');
  });

  it('renders the partial-config-only and fully-initialized headlines', () => {
    const partialConfig = render(
      <InitFeedback
        created={false}
        path="/x/cfg.yml"
        cwd="/x"
        configFilename="opensip-tools.config.yml"
        partialStateError={{ state: 'partial-config-only', preExistingFiles: [], message: 'msg' }}
      />,
    );
    expect(partialConfig.lastFrame()).toContain('present but opensip-tools/ missing');

    const fullyInit = render(
      <InitFeedback
        created={false}
        path="/x/cfg.yml"
        cwd="/x"
        configFilename="opensip-tools.config.yml"
        partialStateError={{ state: 'fully-initialized', preExistingFiles: [], message: 'msg' }}
      />,
    );
    expect(fullyInit.lastFrame()).toContain('Already initialized');
  });

  it('renders the pristine success path with try-it hint and createdFiles', () => {
    const { lastFrame } = render(
      <InitFeedback
        created
        path="/x/opensip-tools.config.yml"
        cwd="/x"
        configFilename="opensip-tools.config.yml"
        state="pristine"
        languages={['typescript']}
        createdFiles={['/x/opensip-tools.config.yml', '/x/opensip-tools/fit/checks/example.mjs']}
        gitignoreUpdated
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Scaffolded');
    expect(out).toContain('typescript');
    expect(out).toContain('opensip-tools.config.yml');
    expect(out).toContain('.gitignore');
    expect(out).toContain('fit --recipe example');
  });

  it('renders "unknown" language when none detected', () => {
    const { lastFrame } = render(
      <InitFeedback created path="/x/cfg.yml" cwd="/x" configFilename="opensip-tools.config.yml" />,
    );
    expect(lastFrame()).toContain('unknown');
  });

  it('shows "Re-scaffolded" headline for fully-initialized created state', () => {
    const { lastFrame } = render(
      <InitFeedback
        created
        path="/x/cfg.yml"
        cwd="/x"
        configFilename="opensip-tools.config.yml"
        state="fully-initialized"
        languages={['typescript']}
      />,
    );
    expect(lastFrame()).toContain('Re-scaffolded');
  });

  it('shows "Recovered partial state" headline for partial-config-only created state', () => {
    const { lastFrame } = render(
      <InitFeedback
        created
        path="/x/cfg.yml"
        cwd="/x"
        configFilename="opensip-tools.config.yml"
        state="partial-config-only"
        languages={['typescript']}
      />,
    );
    expect(lastFrame()).toContain('Recovered partial state');
  });

  it('lists pre-existing files when created with them', () => {
    const { lastFrame } = render(
      <InitFeedback
        created
        path="/x/cfg.yml"
        cwd="/x"
        configFilename="opensip-tools.config.yml"
        state="partial-config-only"
        languages={['typescript']}
        preExistingFiles={[
          { path: '/x/opensip-tools.config.yml', classification: 'custom' },
        ]}
      />,
    );
    expect(lastFrame()).toContain('Pre-existing files');
    expect(lastFrame()).toContain('opensip-tools.config.yml');
  });

  it('renders the failure fallback when created is false and no error info', () => {
    const { lastFrame } = render(
      <InitFeedback
        created={false}
        path="/x/cfg.yml"
        cwd="/x"
        configFilename="opensip-tools.config.yml"
      />,
    );
    expect(lastFrame()).toContain('Failed to scaffold');
  });
});
