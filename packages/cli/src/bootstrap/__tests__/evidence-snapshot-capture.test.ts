import { describe, expect, it } from 'vitest';

import {
  MAX_EVIDENCE_SNAPSHOT_CONTRIBUTIONS,
  captureEvidenceSnapshots,
} from '../evidence-snapshot-capture.js';

function contribution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'inventory',
    snapshotId: 'inventory-1',
    snapshotSchemaVersion: 1,
    producer: { toolId: 'graph-id', command: 'graph-context-inventory' },
    status: 'rebuilt',
    freshness: { status: 'current', reasonCodes: [] },
    coverage: { status: 'complete', items: 2, total: 2, reasonCodes: [] },
    reasons: [],
    followUpReads: ['get_file_context'],
    ...overrides,
  };
}

describe('captureEvidenceSnapshots', () => {
  it('copies and deeply freezes bounded contributions', () => {
    const source = contribution({ inputs: [{ kind: 'graph', snapshotId: 'g1:graph' }] });
    const captured = captureEvidenceSnapshots([source]);
    expect(captured).toEqual([source]);
    expect(captured[0]).not.toBe(source);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured[0]?.producer)).toBe(true);
    expect(Object.isFrozen(captured[0]?.inputs)).toBe(true);
    expect(Object.isFrozen(captured[0]?.inputs?.[0])).toBe(true);
  });

  it('requires durable pointers and rejects unknown nested fields', () => {
    expect(() => captureEvidenceSnapshots([contribution({ snapshotId: undefined })])).toThrow(
      /requires snapshotId and positive snapshotSchemaVersion/u,
    );
    expect(() =>
      captureEvidenceSnapshots([
        contribution({ producer: { toolId: 'graph-id', command: 'run', secret: 'nope' } }),
      ]),
    ).toThrow(/unknown field 'secret'/u);
  });

  it('rejects duplicate kinds and over-cap arrays', () => {
    expect(() => captureEvidenceSnapshots([contribution(), contribution()])).toThrow(
      /duplicate evidence kind/u,
    );
    expect(() =>
      captureEvidenceSnapshots(
        Array.from({ length: MAX_EVIDENCE_SNAPSHOT_CONTRIBUTIONS + 1 }, (_, index) =>
          contribution({ kind: `kind-${String(index)}` }),
        ),
      ),
    ).toThrow(/exceeds/u);
  });

  it('rejects malformed or duplicate immutable input bindings', () => {
    expect(() =>
      captureEvidenceSnapshots([
        contribution({ inputs: [{ kind: 'graph', snapshotId: 'g1:one', extra: true }] }),
      ]),
    ).toThrow(/unknown field 'extra'/u);
    expect(() =>
      captureEvidenceSnapshots([
        contribution({
          inputs: [
            { kind: 'graph', snapshotId: 'g1:one' },
            { kind: 'graph', snapshotId: 'g1:two' },
          ],
        }),
      ]),
    ).toThrow(/duplicate kind 'graph'/u);
  });
});
