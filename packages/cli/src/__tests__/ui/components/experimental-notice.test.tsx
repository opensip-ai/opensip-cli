import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { ExperimentalNotice } from '../../../ui/components/ExperimentalNotice.js';

describe('ExperimentalNotice', () => {
  it('renders the experimental status block', () => {
    const { lastFrame } = render(
      <ExperimentalNotice tool="sim" cwd="/x" />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Status:');
    expect(out).toContain('Under active development');
    expect(out).toContain('https://github.com/opensip-ai/opensip-tools/issues');
  });
});
