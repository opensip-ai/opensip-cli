/**
 * Unit tests for the pure `analyzeBlessedSeam` detector (release 2.13.0, §4.8).
 * (The check self-reads docs/public/50-extend, so the analyze function — not an
 * on-disk fixture — is its teeth; see fixture-coverage.allowlist KNOWN_UNFIXTURABLE.)
 */
import { describe, expect, it } from 'vitest';

import { analyzeBlessedSeam } from '../docs-teach-blessed-seam.js';

describe('analyzeBlessedSeam', () => {
  it("flags a hand-rolled .option('--json') in a doc example", () => {
    const hits = analyzeBlessedSeam("      .option('--json', 'Output structured JSON', false)");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.what).toContain('--json');
  });

  it('flags a raw process.stdout.write in a doc example', () => {
    expect(
      analyzeBlessedSeam('        process.stdout.write(JSON.stringify(result));').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag the blessed seam (commandSpecs / defineCommand / emit seams)', () => {
    expect(
      analyzeBlessedSeam("commandSpecs: [defineCommand({ name: 'x', commonFlags: ['json'] })]"),
    ).toHaveLength(0);
    expect(analyzeBlessedSeam('return result; // the host owns --json')).toHaveLength(0);
  });
});
