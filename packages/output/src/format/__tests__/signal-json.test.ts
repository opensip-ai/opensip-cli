import { describe, expect, it } from 'vitest';

import { formatSignalJson } from '../signal-json.js';

import { EMPTY_ENVELOPE, FIXTURE_ENVELOPE } from './envelope.fixtures.js';

import type { SignalEnvelope } from '@opensip-tools/contracts';

describe('formatSignalJson', () => {
  it('serialises the envelope as pretty JSON (snapshot)', () => {
    expect(formatSignalJson(FIXTURE_ENVELOPE)).toMatchSnapshot();
  });

  it('round-trips: the parsed JSON equals the envelope', () => {
    const parsed = JSON.parse(formatSignalJson(FIXTURE_ENVELOPE)) as SignalEnvelope;
    expect(parsed).toEqual(FIXTURE_ENVELOPE);
  });

  it('keeps verdict.passed and verdict.score jq-able at the top level', () => {
    const parsed = JSON.parse(formatSignalJson(FIXTURE_ENVELOPE)) as SignalEnvelope;
    expect(parsed.verdict.passed).toBe(false);
    expect(parsed.verdict.score).toBe(50);
  });

  it('is pure — same input renders byte-identical output', () => {
    expect(formatSignalJson(EMPTY_ENVELOPE)).toBe(formatSignalJson(EMPTY_ENVELOPE));
  });
});
