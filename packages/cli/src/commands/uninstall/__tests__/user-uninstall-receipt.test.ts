import { describe, expect, it } from 'vitest';

import {
  advanceReceipt,
  buildOpenReceipt,
  closeReceipt,
  digestMarkerContent,
  newMarkerContent,
  newOperationId,
  newTombstoneBasename,
  parseReceiptBody,
  serializeReceipt,
  USER_UNINSTALL_MARKER_BASENAME,
} from '../user-uninstall-receipt.js';

describe('user-uninstall-receipt helpers', () => {
  it('builds a bounded open receipt without absolute paths', () => {
    const operationId = newOperationId();
    const tombstoneBasename = newTombstoneBasename(operationId);
    const markerDigest = digestMarkerContent(newMarkerContent());
    const receipt = buildOpenReceipt({
      operationId,
      phase: 'marker-create-intent',
      tombstoneBasename,
      markerDigest,
    });
    expect(receipt.kind).toBe('user-uninstall');
    expect(receipt.state).toBe('open');
    expect(receipt.markerBasename).toBe(USER_UNINSTALL_MARKER_BASENAME);
    expect(receipt.tombstoneBasename.startsWith('.opensip-user-uninstall-tombstone-')).toBe(true);
    const json = serializeReceipt(receipt);
    expect(json).not.toMatch(/\/Users\//);
    expect(json).not.toMatch(/HOME/);
    expect(parseReceiptBody(json)).toMatchObject({
      operationId,
      phase: 'marker-create-intent',
    });
  });

  it('advances phases and closes', () => {
    const receipt = buildOpenReceipt({
      operationId: 'uu-abc',
      phase: 'marker-create-intent',
      tombstoneBasename: newTombstoneBasename('uu-abc'),
      markerDigest: 'd'.repeat(64),
    });
    const advanced = advanceReceipt(receipt, 'marker-created');
    expect(advanced.phase).toBe('marker-created');
    const closed = closeReceipt(advanced);
    expect(closed.state).toBe('closed');
    expect(closed.phase).toBe('deleted');
  });

  it('rejects malformed receipt bodies', () => {
    expect(parseReceiptBody('{')).toBeUndefined();
    expect(parseReceiptBody(JSON.stringify({ kind: 'other' }))).toBeUndefined();

    const valid = buildOpenReceipt({
      operationId: 'uu-abc',
      phase: 'marker-create-intent',
      tombstoneBasename: newTombstoneBasename('uu-abc'),
      markerDigest: 'd'.repeat(64),
    });
    for (const malformed of [
      null,
      [],
      { ...valid, phase: 'arbitrary-phase' },
      { ...valid, tombstoneBasename: '../outside' },
      { ...valid, markerDigest: 'short' },
      { ...valid, createdAtMs: Number.NaN },
      { ...valid, reason: 'x'.repeat(97) },
      { ...valid, state: 'closed', phase: 'renamed' },
    ]) {
      expect(parseReceiptBody(JSON.stringify(malformed))).toBeUndefined();
    }
    expect(
      parseReceiptBody(
        JSON.stringify({
          ...valid,
          updatedAtMs: valid.createdAtMs - 1,
        }),
      ),
    ).toMatchObject({ operationId: valid.operationId });
  });
});
