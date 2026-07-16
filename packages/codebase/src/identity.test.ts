import { describe, expect, it } from 'vitest';

import { projectConfigIdentity } from './identity.js';

describe('projectConfigIdentity', () => {
  it('is stable across object key order and differs for semantic changes', () => {
    const left = projectConfigIdentity({ graph: { mode: 'exact', depth: 3 }, targets: ['src'] });
    const reordered = projectConfigIdentity({
      targets: ['src'],
      graph: { depth: 3, mode: 'exact' },
    });
    const changed = projectConfigIdentity({ targets: ['src'], graph: { depth: 4, mode: 'exact' } });

    expect(left).toBe(reordered);
    expect(left).not.toBe(changed);
    expect(left).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('hashes complete deep and broad validated documents without lossy caps', () => {
    let deepLeft: unknown = 'left';
    let deepRight: unknown = 'right';
    for (let index = 0; index < 40; index += 1) {
      deepLeft = { child: deepLeft };
      deepRight = { child: deepRight };
    }
    const wideLeft = Object.fromEntries(
      Array.from({ length: 10_100 }, (_, index) => [
        `key-${String(index).padStart(5, '0')}`,
        index,
      ]),
    );
    const wideRight = { ...wideLeft, 'key-10099': 'changed' };

    expect(projectConfigIdentity({ deep: deepLeft, wide: wideLeft })).toBe(
      projectConfigIdentity({ wide: wideLeft, deep: deepLeft }),
    );
    expect(projectConfigIdentity({ deep: deepLeft })).not.toBe(
      projectConfigIdentity({ deep: deepRight }),
    );
    expect(projectConfigIdentity({ wide: wideLeft })).not.toBe(
      projectConfigIdentity({ wide: wideRight }),
    );
  });

  it('hashes differences after the first MiB instead of truncating valid config input', () => {
    const shared = 'x'.repeat(1024 * 1024 + 128);
    const left = projectConfigIdentity({ shared, tail: 'left' });
    const right = projectConfigIdentity({ shared, tail: 'right' });

    expect(left).not.toBe(right);
  });

  it('matches JSON omission/null semantics and rejects unsupported recursive values', () => {
    const omitted = projectConfigIdentity({
      retained: 1,
      undefinedValue: undefined,
      functionValue: () => 'ignored',
      symbolValue: Symbol('ignored'),
    });
    expect(omitted).toBe(projectConfigIdentity({ retained: 1 }));
    expect(
      projectConfigIdentity({ values: [undefined, () => 'null', Symbol('null'), Number.NaN] }),
    ).toBe(projectConfigIdentity({ values: [null, null, null, null] }));

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => projectConfigIdentity(circular)).toThrow(/circular values/u);
    expect(() => projectConfigIdentity({ unsupported: 1n })).toThrow(/bigint values/u);
  });
});
