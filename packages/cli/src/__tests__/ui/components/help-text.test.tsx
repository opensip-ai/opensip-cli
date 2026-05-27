import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { HelpText } from '../../../ui/components/HelpText.js';

describe('HelpText', () => {
  it('renders the help summary with command names', () => {
    const { lastFrame } = render(<HelpText />);
    const out = lastFrame() ?? '';
    expect(out).toContain('opensip-tools');
    expect(out).toContain('Codebase analysis toolkit');
    expect(out).toContain('fit');
    expect(out).toContain('init');
    expect(out).toContain('sim');
    expect(out).toContain('plugin');
  });
});
