import { describe, expect, it } from 'vitest';

import { normalizeDiscovery } from '../manifest-discovery.js';

// A fully-populated, valid `discovery` descriptor. Each invalid-branch test
// clones this and corrupts exactly one field, so a failure pinpoints the
// single rejected field rather than an unrelated shape error.
function validDiscovery(): Record<string, unknown> {
  return {
    discovery: { mode: 'marker', markerKind: 'tool' },
    exportName: 'register',
    exportShape: 'array',
    configKeys: {
      packages: 'plugins.tools',
      autoDiscover: 'auto',
      scopes: 'scope',
    },
    builtinScope: 'core',
    explicitListMode: 'replace',
    coContributions: [{ exportName: 'recipes', exportShape: 'array', domainId: 'fit-recipe' }],
  };
}

describe('normalizeDiscovery — absent / non-record', () => {
  it('returns absent when the field is undefined', () => {
    expect(normalizeDiscovery(undefined)).toEqual({ status: 'absent' });
  });

  it('rejects a non-record value as invalid', () => {
    expect(normalizeDiscovery('nope').status).toBe('invalid');
    expect(normalizeDiscovery(42).status).toBe('invalid');
    expect(normalizeDiscovery(null).status).toBe('invalid');
  });
});

describe('normalizeDiscovery — happy path', () => {
  it('accepts a fully-populated descriptor and carries every field through', () => {
    const result = normalizeDiscovery(validDiscovery());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.descriptor).toEqual({
      discovery: { mode: 'marker', markerKind: 'tool' },
      exportName: 'register',
      exportShape: 'array',
      configKeys: {
        packages: 'plugins.tools',
        autoDiscover: 'auto',
        scopes: 'scope',
      },
      builtinScope: 'core',
      explicitListMode: 'replace',
      coContributions: [{ exportName: 'recipes', exportShape: 'array', domainId: 'fit-recipe' }],
    });
  });

  it('accepts the minimal descriptor (optionals omitted)', () => {
    const result = normalizeDiscovery({
      discovery: { mode: 'marker', markerKind: 'tool' },
      exportName: 'register',
      exportShape: 'single',
      configKeys: {},
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.descriptor.builtinScope).toBeUndefined();
    expect(result.descriptor.explicitListMode).toBeUndefined();
    expect(result.descriptor.coContributions).toBeUndefined();
  });

  it('accepts a name-pattern discovery mode', () => {
    const result = normalizeDiscovery({
      discovery: {
        mode: 'name-pattern',
        prefix: 'opensip-',
        defaultScopes: ['backend'],
      },
      exportName: 'register',
      exportShape: 'array',
      configKeys: {},
    });
    expect(result.status).toBe('ok');
  });
});

describe('normalizeDiscovery — invalid top-level fields', () => {
  it.each([
    ['exportName missing', (d: Record<string, unknown>) => delete d.exportName],
    ['exportName empty', (d: Record<string, unknown>) => (d.exportName = '')],
    ['exportShape invalid', (d: Record<string, unknown>) => (d.exportShape = 'list')],
    ['configKeys non-record', (d: Record<string, unknown>) => (d.configKeys = 7)],
    [
      'configKeys non-string member',
      (d: Record<string, unknown>) => (d.configKeys = { packages: 1 }),
    ],
    // line 41-42: builtinScope present but not a string
    ['builtinScope non-string', (d: Record<string, unknown>) => (d.builtinScope = 5)],
    // line 43-49: explicitListMode present but not replace|augment
    ['explicitListMode invalid', (d: Record<string, unknown>) => (d.explicitListMode = 'merge')],
  ])('rejects when %s', (_label, corrupt) => {
    const d = validDiscovery();
    corrupt(d);
    expect(normalizeDiscovery(d).status).toBe('invalid');
  });
});

describe('normalizeDiscovery — invalid discovery mode', () => {
  it.each([
    ['mode field non-record', { discovery: 'marker' }],
    ['unknown mode', { discovery: { mode: 'spelunk' } }],
    ['marker mode missing markerKind', { discovery: { mode: 'marker' } }],
    ['marker mode empty markerKind', { discovery: { mode: 'marker', markerKind: '' } }],
    ['name-pattern missing prefix', { discovery: { mode: 'name-pattern', defaultScopes: [] } }],
    [
      'name-pattern bad defaultScopes',
      { discovery: { mode: 'name-pattern', prefix: 'p', defaultScopes: 'x' } },
    ],
  ])('rejects when %s', (_label, override) => {
    const d = { ...validDiscovery(), ...override };
    expect(normalizeDiscovery(d).status).toBe('invalid');
  });
});

describe('normalizeDiscovery — coContributions validation', () => {
  it('accepts an absent coContributions field', () => {
    const d = validDiscovery();
    delete d.coContributions;
    expect(normalizeDiscovery(d).status).toBe('ok');
  });

  it.each([
    ['coContributions not an array', (d: Record<string, unknown>) => (d.coContributions = {})],
    ['entry not a record', (d: Record<string, unknown>) => (d.coContributions = ['x'])],
    // line 79-80: entry.exportName missing/empty
    [
      'entry exportName empty',
      (d: Record<string, unknown>) =>
        (d.coContributions = [{ exportName: '', exportShape: 'array', domainId: 'x' }]),
    ],
    // line 81-82: entry.exportShape invalid
    [
      'entry exportShape invalid',
      (d: Record<string, unknown>) =>
        (d.coContributions = [{ exportName: 'r', exportShape: 'blob', domainId: 'x' }]),
    ],
    [
      'entry domainId empty',
      (d: Record<string, unknown>) =>
        (d.coContributions = [{ exportName: 'r', exportShape: 'array', domainId: '' }]),
    ],
  ])('rejects when %s', (_label, corrupt) => {
    const d = validDiscovery();
    corrupt(d);
    expect(normalizeDiscovery(d).status).toBe('invalid');
  });
});
