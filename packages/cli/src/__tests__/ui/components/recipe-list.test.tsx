import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { RecipeList } from '../../../ui/components/RecipeList.js';

describe('RecipeList', () => {
  it('renders an empty list with just the header', () => {
    const { lastFrame } = render(<RecipeList recipes={[]} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('Available Recipes');
  });

  it('renders a recipe row for each entry', () => {
    const { lastFrame } = render(
      <RecipeList
        recipes={[
          { name: 'fast', description: 'Quick smoke checks', checkCount: '5 checks' },
          { name: 'full', description: 'Everything', checkCount: '120 checks' },
        ]}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('fast');
    expect(out).toContain('Quick smoke checks');
    expect(out).toContain('5 checks');
    expect(out).toContain('full');
    expect(out).toContain('120 checks');
  });
});
