import { describe, it, expect } from 'vitest';

import { projectDurationDisplay, projectSessionDisplay } from './project-session.js';

import * as formatApi from './index.js';

describe('projectDurationDisplay', () => {
  it('echoes raw durationMs and labels via formatDuration', () => {
    expect(projectDurationDisplay(19_850)).toEqual({
      durationMs: 19_850,
      durationLabel: '19.9s',
    });
  });

  it('labels non-finite inputs while echoing the caller raw', () => {
    expect(projectDurationDisplay(Number.NaN)).toEqual({
      durationMs: Number.NaN,
      durationLabel: '0ms',
    });
  });
});

describe('projectSessionDisplay', () => {
  it('labels a precomputed score+duration pair', () => {
    expect(projectSessionDisplay({ durationMs: 12_340, score: 88 })).toEqual({
      durationMs: 12_340,
      durationLabel: '12.3s',
      score: 88,
      scoreLabel: '88%',
    });
  });

  it('is suitable for already-aggregated suite totals (caller owns aggregation)', () => {
    // Caller summed durations and averaged/scored upstream.
    expect(projectSessionDisplay({ durationMs: 40_000, score: 50 })).toEqual({
      durationMs: 40_000,
      durationLabel: '40.0s',
      score: 50,
      scoreLabel: '50%',
    });
  });
});

describe('public API shape (no business aggregation)', () => {
  it('exports only the locked value APIs', () => {
    expect(Object.keys(formatApi).sort()).toEqual([
      'formatDuration',
      'formatScore',
      'projectDurationDisplay',
      'projectSessionDisplay',
    ]);
  });

  it('does not export a sessions-array projector', () => {
    const banned = ['projectSuiteDisplay', 'projectScoreDurationDisplay', 'aggregateSuite'];
    for (const name of banned) {
      expect(formatApi).not.toHaveProperty(name);
    }
  });
});
