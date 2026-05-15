import { describe, expect, it } from 'vitest';

import {
  PERSONAS,
  getEstimatedRps,
  getPersonaTypes,
  getTotalPersonaCount,
  persona,
} from '../personas.js';

describe('persona()', () => {
  it('builds a frozen PersonaConfig with defaults', () => {
    const p = persona('buyer', 10);
    expect(p.personaId).toBe('buyer-default');
    expect(p.count).toBe(10);
    expect(p.spawnRate).toBe(0.5);
    expect(p.actions).toEqual(['random']);
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('honors variant override', () => {
    expect(persona('buyer', 1, { variant: 'aggressive' }).personaId).toBe('buyer-aggressive');
  });

  it('honors spawnRate override', () => {
    expect(persona('buyer', 1, { spawnRate: 2.5 }).spawnRate).toBe(2.5);
  });

  it('honors actions override and freezes the array', () => {
    const p = persona('admin', 1, { actions: ['moderate', 'review'] });
    expect(p.actions).toEqual(['moderate', 'review']);
    expect(Object.isFrozen(p.actions)).toBe(true);
  });
});

describe('PERSONAS presets', () => {
  it('standardMix returns three buyer/seller/admin entries', () => {
    const out = PERSONAS.standardMix();
    expect(out).toHaveLength(3);
    expect(getTotalPersonaCount(out)).toBe(16);
  });

  it('fullMix returns six entries', () => {
    expect(PERSONAS.fullMix()).toHaveLength(6);
  });

  it('minimal returns two entries', () => {
    expect(PERSONAS.minimal()).toHaveLength(2);
  });

  it('buyerHeavy scales with the count argument', () => {
    const out = PERSONAS.buyerHeavy(40);
    expect(out[0]?.count).toBe(40);
    expect(out[1]?.count).toBe(10);
  });

  it('buyerHeavy uses 20 buyers by default', () => {
    expect(PERSONAS.buyerHeavy()[0]?.count).toBe(20);
  });

  it('sellerHeavy mirrors buyerHeavy with sellers as primary', () => {
    const out = PERSONAS.sellerHeavy(40);
    expect(out[0]?.personaId).toContain('seller');
    expect(out[0]?.count).toBe(40);
  });

  it('adversarial includes attacker personas', () => {
    const out = PERSONAS.adversarial();
    expect(out.some((p) => p.personaId.startsWith('attacker'))).toBe(true);
  });

  it('loadTest splits users 60/30/10 by default 100', () => {
    const out = PERSONAS.loadTest();
    expect(out).toHaveLength(3);
    expect(out[0]?.count).toBe(60);
    expect(out[1]?.count).toBe(30);
    expect(out[2]?.count).toBe(10);
  });

  it('spikeTest scales by base users', () => {
    const out = PERSONAS.spikeTest();
    expect(out[0]?.count).toBe(50);
  });

  it('only returns a single-entry array', () => {
    const out = PERSONAS.only('seller', 7);
    expect(out).toHaveLength(1);
    expect(out[0]?.count).toBe(7);
  });

  it('adminsOnly defaults to 3 admins', () => {
    expect(PERSONAS.adminsOnly()[0]?.count).toBe(3);
  });
});

describe('persona utilities', () => {
  const mix = [persona('buyer', 10, { spawnRate: 2 }), persona('seller', 5, { spawnRate: 1 })];

  it('getTotalPersonaCount sums counts', () => {
    expect(getTotalPersonaCount(mix)).toBe(15);
  });

  it('getEstimatedRps sums count * spawnRate', () => {
    expect(getEstimatedRps(mix)).toBe(25);
  });

  it('getPersonaTypes deduplicates by type', () => {
    const out = getPersonaTypes([
      persona('buyer', 1, { variant: 'a' }),
      persona('buyer', 1, { variant: 'b' }),
      persona('seller', 1),
    ]);
    expect([...out].sort()).toEqual(['buyer', 'seller']);
  });

  it('getTotalPersonaCount returns 0 for empty input', () => {
    expect(getTotalPersonaCount([])).toBe(0);
  });
});
