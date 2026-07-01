/**
 * Java cacheKey implementation.
 *
 * Produces `java-${buildFileHash || 'no-config'}-${resolutionMode}`.
 *
 * Java has no canonical resolved-dependency lock file like Cargo.lock
 * or go.sum. Maven's `pom.xml` and Gradle's `build.gradle` /
 * `build.gradle.kts` are the build-config sources of truth, so we
 * fingerprint those. Gradle does emit `gradle.lockfile` when locking
 * is enabled but it's opt-in; we treat it as preferred when present
 * since it captures the resolved versions. The precedence is encoded in
 * `discover.ts`'s config-candidate list; this module just fingerprints
 * whichever anchor discover picked.
 *
 * Per contract invariant I-6: pure function of `(config content)`.
 * Per I-8: emits `java-`, distinct from `rs-`, `py-`, `go-`.
 */

import { makeConfigCacheKey } from '@opensip-cli/graph-adapter-common';

export const cacheKey = makeConfigCacheKey({ prefix: 'java' });
