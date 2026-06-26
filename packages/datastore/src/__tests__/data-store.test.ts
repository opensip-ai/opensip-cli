/**
 * data-store — the public persistence handle boundary helpers.
 *
 * Covers the `isDrizzleDataStore` type guard (every shape branch), the
 * `requireDrizzleDataStore` narrow-or-throw, and the `DataStoreMigrationError`
 * carrier. These guard the raw-Drizzle boundary (`restrict-raw-db-access`), so
 * each rejection branch must stay pinned.
 */

import { describe, expect, it } from 'vitest';

import {
  DataStoreMigrationError,
  isDrizzleDataStore,
  requireDrizzleDataStore,
} from '../data-store.js';

import type { DataStore } from '../data-store.js';

/** A minimal object that satisfies the Drizzle-backed shape. */
const drizzleLike = (): unknown => ({
  db: {},
  transaction: () => undefined,
  close: () => undefined,
});

describe('isDrizzleDataStore', () => {
  it('accepts an object carrying db + transaction() + close()', () => {
    expect(isDrizzleDataStore(drizzleLike())).toBe(true);
  });

  it('rejects non-objects and null', () => {
    expect(isDrizzleDataStore('nope')).toBe(false);
    expect(isDrizzleDataStore(42)).toBe(false);
    expect(isDrizzleDataStore(undefined)).toBe(false);
    expect(isDrizzleDataStore(null)).toBe(false);
  });

  it('rejects when `db` is absent', () => {
    expect(
      isDrizzleDataStore({
        transaction: () => undefined,
        close: () => undefined,
      }),
    ).toBe(false);
  });

  it('rejects when `transaction` is absent or not a function', () => {
    expect(isDrizzleDataStore({ db: {}, close: () => undefined })).toBe(false);
    expect(isDrizzleDataStore({ db: {}, transaction: 'x', close: () => undefined })).toBe(false);
  });

  it('rejects when `close` is absent or not a function', () => {
    expect(isDrizzleDataStore({ db: {}, transaction: () => undefined })).toBe(false);
    expect(isDrizzleDataStore({ db: {}, transaction: () => undefined, close: 'x' })).toBe(false);
  });
});

describe('requireDrizzleDataStore', () => {
  it('returns the store unchanged when it is Drizzle-backed', () => {
    const store = drizzleLike();
    expect(requireDrizzleDataStore(store as DataStore)).toBe(store);
  });

  it('throws when the store is not Drizzle-backed', () => {
    const plain = {
      transaction: () => undefined,
      close: () => undefined,
    } as unknown as DataStore;
    expect(() => requireDrizzleDataStore(plain)).toThrow(/Drizzle-backed DataStore is required/);
  });
});

describe('DataStoreMigrationError', () => {
  it('carries the message, name, migrationFile, and cause', () => {
    const cause = new Error('disk full');
    const err = new DataStoreMigrationError('migration failed', {
      migrationFile: '0007_add_index.sql',
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DataStoreMigrationError');
    expect(err.message).toBe('migration failed');
    expect(err.migrationFile).toBe('0007_add_index.sql');
    expect(err.cause).toBe(cause);
  });

  it('defaults migrationFile and cause to undefined', () => {
    const err = new DataStoreMigrationError('boom');
    expect(err.migrationFile).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});
