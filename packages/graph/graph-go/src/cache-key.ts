/**
 * Go cacheKey implementation.
 *
 * Produces `go-${goSumHash || goModHash || 'no-config'}-${resolutionMode}`.
 *
 * Prefers go.sum over go.mod when both are present — go.sum holds the
 * resolved dependency tree (with hashes), so changing a dep version
 * reliably flips the key. go.mod (the manifest) is the fallback when
 * go.sum isn't checked in (rare; Go conventionally commits it). The
 * precedence is encoded in `discover.ts`'s config-candidate list; this
 * module just fingerprints whichever anchor discover picked.
 *
 * Per contract invariant I-6: pure function of `(config content)`.
 * Per I-8: emits `go-`, distinct from `rs-` and `py-`.
 */

import { makeConfigCacheKey } from '@opensip-cli/graph-adapter-common';

export const cacheKey = makeConfigCacheKey({ prefix: 'go' });
