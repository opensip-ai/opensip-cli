/**
 * ADR-0036 enforcement guard (1): the host baseline/ratchet plane is FREE for a
 * new tool. The toy fixture tool authors zero persistence/diff/fingerprint code
 * (see fixtures/toy-tool/tool.ts) — its signals flow through the REAL host seams
 * (`buildBaselineSeams` over a memory DataStore) and get a working save → compare
 * ratchet: no-flap on the unchanged set, degraded on a net-new finding, and a
 * missing-baseline error before the first save.
 */

import { logger } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildBaselineSeams, type BaselineSeams } from '../bootstrap/baseline-seams.js';

import { buildToyEnvelope, toyNetNewSignal, TOY_TOOL_ID } from './fixtures/toy-tool/tool.js';

let ds: DataStore;
let seams: BaselineSeams;

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
  seams = buildBaselineSeams({ getDatastore: () => ds, logger });
});

afterEach(() => {
  ds.close();
});

describe('toy-tool baseline plane (zero tool-authored persistence/diff/fingerprint)', () => {
  it('save → compare on the unchanged set yields no flap (added=[] degraded=false)', async () => {
    const env = buildToyEnvelope();
    await seams.saveBaseline(TOY_TOOL_ID, env);
    const result = await seams.compareBaseline(TOY_TOOL_ID, env);
    expect(result.added).toEqual([]);
    expect(result.unchanged).toHaveLength(env.signals.length);
    expect(result.degraded).toBe(false);
  });

  it('a net-new signal flips degraded=true with that one signal in `added`', async () => {
    await seams.saveBaseline(TOY_TOOL_ID, buildToyEnvelope());
    const result = await seams.compareBaseline(TOY_TOOL_ID, buildToyEnvelope([toyNetNewSignal()]));
    expect(result.degraded).toBe(true);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].ruleId).toBe('toy:rule-c');
  });

  it('compare before any save reports the missing baseline (→ exit 2)', async () => {
    await expect(seams.compareBaseline(TOY_TOOL_ID, buildToyEnvelope())).rejects.toThrow(
      /baseline/i,
    );
  });

  it('re-saving with a net-new finding makes the next compare clean again (drop-and-recapture)', async () => {
    await seams.saveBaseline(TOY_TOOL_ID, buildToyEnvelope([toyNetNewSignal()]));
    const result = await seams.compareBaseline(TOY_TOOL_ID, buildToyEnvelope([toyNetNewSignal()]));
    expect(result.degraded).toBe(false);
  });
});
