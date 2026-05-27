import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { CheckList } from '../../../ui/components/CheckList.js';

describe('CheckList', () => {
  it('renders the header with total count', () => {
    const { lastFrame } = render(
      <CheckList checks={[]} totalCount={42} />,
    );
    expect(lastFrame()).toContain('Available Fitness Checks');
    expect(lastFrame()).toContain('42 total');
  });

  it('groups checks by tag in alphabetical order', () => {
    const { lastFrame } = render(
      <CheckList
        totalCount={2}
        checks={[
          { slug: 'check-b', description: 'b desc', tags: ['security'] },
          { slug: 'check-a', description: 'a desc', tags: ['security'] },
          { slug: 'check-c', description: 'c desc', tags: ['quality'] },
        ]}
      />,
    );
    const out = lastFrame() ?? '';
    // quality (q) should appear before security (s).
    const qPos = out.indexOf('quality');
    const sPos = out.indexOf('security');
    expect(qPos).toBeGreaterThan(0);
    expect(sPos).toBeGreaterThan(0);
    expect(qPos).toBeLessThan(sPos);
    // Checks within a tag are alphabetically sorted by slug.
    const aPos = out.indexOf('check-a');
    const bPos = out.indexOf('check-b');
    expect(aPos).toBeLessThan(bPos);
  });

  it('puts untagged checks into the "untagged" group', () => {
    const { lastFrame } = render(
      <CheckList
        totalCount={1}
        checks={[
          { slug: 'check-x', description: 'desc', tags: [] },
        ]}
      />,
    );
    expect(lastFrame()).toContain('untagged');
    expect(lastFrame()).toContain('check-x');
  });

  it('lists every check across multiple tags', () => {
    const { lastFrame } = render(
      <CheckList
        totalCount={1}
        checks={[
          { slug: 'check-multi', description: 'd', tags: ['a', 'b'] },
        ]}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('check-multi');
    // Should be listed under both tags.
    expect(out.match(/check-multi/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
