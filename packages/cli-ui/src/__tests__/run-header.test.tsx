import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { RunHeader } from '../run-header.js';

describe('RunHeader', () => {
  it('renders the tool name and separator', () => {
    const { lastFrame } = render(<RunHeader tool="Fitness Checks" />);
    const out = lastFrame() ?? '';
    expect(out).toContain('Fitness Checks');
    expect(out).toContain('─');
  });

  it('does not render the project line (owned by ProjectHeader)', () => {
    const { lastFrame } = render(<RunHeader tool="X" />);
    expect(lastFrame() ?? '').not.toContain('Project:');
  });

  it('renders metadata rows', () => {
    const { lastFrame } = render(
      <RunHeader
        tool="X"
        metadata={[
          { label: 'Recipe', value: 'example' },
          { label: 'Files', value: '42' },
        ]}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Recipe: example');
    expect(out).toContain('Files: 42');
  });

  it('renders the description block when supplied', () => {
    const { lastFrame } = render(<RunHeader tool="X" description="run the checks" />);
    expect(lastFrame()).toContain('run the checks');
  });
});
