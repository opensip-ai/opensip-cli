import { describe, expect, it } from 'vitest';

import { checkDisplay } from '../display/index.js';

describe('checkDisplay metadata', () => {
  it('maps the no-bare-except slug to its [icon, name] tuple', () => {
    expect(checkDisplay['no-bare-except']).toEqual(['🐍', 'No Bare Except']);
  });

  it('every entry is a non-empty [icon, displayName] string tuple', () => {
    const entries = Object.entries(checkDisplay);
    expect(entries.length).toBeGreaterThan(0);
    for (const [slug, entry] of entries) {
      expect(slug.length).toBeGreaterThan(0);
      expect(entry).toHaveLength(2);
      const [icon, name] = entry;
      expect(typeof icon).toBe('string');
      expect(icon.length).toBeGreaterThan(0);
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
