import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { RunHeader } from '../run-header.js';

describe('RunHeader', () => {
  it('renders the tool name, project line, and separator', () => {
    const { lastFrame } = render(
      <RunHeader tool="Fitness Checks" projectRoot="/path/to/proj" />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Fitness Checks');
    expect(out).toContain('Project: /path/to/proj');
    expect(out).toContain('─');
  });

  it('omits the "found N levels up" suffix when walkedUp = 0', () => {
    const { lastFrame } = render(
      <RunHeader tool="X" projectRoot="/p" walkedUp={0} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Project: /p');
    expect(out).not.toContain('found');
  });

  it('uses "1 level up" suffix for walkedUp = 1', () => {
    const { lastFrame } = render(
      <RunHeader tool="X" projectRoot="/p" walkedUp={1} />,
    );
    expect(lastFrame()).toContain('found 1 level up');
  });

  it('uses "N levels up" suffix for walkedUp > 1', () => {
    const { lastFrame } = render(
      <RunHeader tool="X" projectRoot="/p" walkedUp={3} />,
    );
    expect(lastFrame()).toContain('found 3 levels up');
  });

  it('prepends extra metadata rows before the project line', () => {
    const { lastFrame } = render(
      <RunHeader
        tool="X"
        projectRoot="/p"
        metadata={[
          { label: 'Recipe', value: 'example' },
          { label: 'Files', value: '42' },
        ]}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Recipe: example');
    expect(out).toContain('Files: 42');
    // Project line still rendered.
    expect(out).toContain('Project: /p');
  });

  it('renders the description block when supplied', () => {
    const { lastFrame } = render(
      <RunHeader tool="X" projectRoot="/p" description="run the checks" />,
    );
    expect(lastFrame()).toContain('run the checks');
  });
});
