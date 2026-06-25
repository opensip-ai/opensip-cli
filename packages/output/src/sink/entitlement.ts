/**
 * Entitlement check for OpenSIP Cloud signal sync (ADR-0008).
 *
 * Answers "is this API key entitled to store signals?" with a locally cached
 * result (so it is not a network round-trip every run) and a **fail-closed**
 * default: on any ambiguity — no key, unreachable endpoint, non-2xx, malformed
 * body — the answer is `entitled: false` and no positive cache entry is
 * written. Data leaves the machine only on a clear positive signal.
 *
 * The ingestion/entitlement endpoint lives in the parent `opensip` repo and
 * does not exist yet; this client codes against the agreed contract and is
 * fully testable by injecting `fetchImpl` + `now` + a temp `cacheDir`.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { logger } from '@opensip-cli/core';

const MODULE_TAG = 'entitlement';
const POSITIVE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — re-check entitled keys infrequently
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // 5m — a real "no" caches briefly to avoid hammering
const REQUEST_TIMEOUT_MS = 10_000;

/** Where the decision came from — also the metric dimension. */
export type EntitlementSource = 'cache' | 'network' | 'fail-closed';
export interface EntitlementResult {
  readonly entitled: boolean;
  readonly source: EntitlementSource;
}

interface CacheEntry {
  entitled: boolean;
  checkedAt: number;
}

/** Input to {@link checkEntitlement}. `now`/`fetchImpl`/`cacheDir` are injectable for tests. */
export interface CheckEntitlementInput {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly now: number;
  readonly cacheDir: string;
  readonly fetchImpl?: typeof fetch;
}

function cacheFileFor(cacheDir: string, apiKey: string): string {
  // Key the cache by a hash of the API key, never the key itself.
  const hash = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return join(cacheDir, `entitlement-${hash}.json`);
}

async function readCache(file: string, now: number): Promise<boolean | undefined> {
  try {
    const entry = JSON.parse(await readFile(file, 'utf8')) as CacheEntry;
    const ttl = entry.entitled ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (now - entry.checkedAt < ttl) return entry.entitled;
  } catch {
    /* missing or corrupt cache → treat as a miss */
  }
  return undefined;
}

async function writeCache(file: string, entitled: boolean, now: number): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ entitled, checkedAt: now } satisfies CacheEntry));
  } catch {
    /* cache write is best-effort — a failure just means we re-check next run */
  }
}

function log(result: EntitlementResult): EntitlementResult {
  // Structured event doubles as the metric signal (labelled by source); never the key.
  logger.info({
    evt: 'cli.signal-sync.entitlement',
    module: MODULE_TAG,
    entitled: result.entitled,
    source: result.source,
  });
  return result;
}

/**
 * Resolve entitlement: cache hit → use it; else a single network check; any
 * failure → fail-closed. A clear `401`/`403` or `{ entitled: false }` is a real
 * negative (cached briefly); a transport/format failure is fail-closed and not
 * cached as confident.
 */
export async function checkEntitlement(input: CheckEntitlementInput): Promise<EntitlementResult> {
  const { apiKey, endpoint, now, cacheDir } = input;
  if (!apiKey) return log({ entitled: false, source: 'fail-closed' });

  const file = cacheFileFor(cacheDir, apiKey);
  const cached = await readCache(file, now);
  if (cached !== undefined) return log({ entitled: cached, source: 'cache' });

  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const url = endpoint.endsWith('/entitlements') ? endpoint : `${endpoint}/entitlements`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401 || res.status === 403) {
      await writeCache(file, false, now); // real negative
      return log({ entitled: false, source: 'network' });
    }
    if (!res.ok) return log({ entitled: false, source: 'fail-closed' }); // 5xx/other → don't trust, don't cache

    const body = (await res.json().catch(() => null)) as { entitled?: unknown } | null;
    if (!body || typeof body.entitled !== 'boolean') {
      return log({ entitled: false, source: 'fail-closed' });
    }
    await writeCache(file, body.entitled, now);
    return log({ entitled: body.entitled, source: 'network' });
  } catch {
    return log({ entitled: false, source: 'fail-closed' });
  }
}

/** Delete the cached entitlement for a key — called after a 401/403 at emit so a
 *  revoked plan re-checks on the next run rather than waiting out the TTL. */
export async function invalidateEntitlement(input: {
  apiKey: string;
  cacheDir: string;
}): Promise<void> {
  try {
    await rm(cacheFileFor(input.cacheDir, input.apiKey), { force: true });
  } catch {
    /* best-effort */
  }
}
