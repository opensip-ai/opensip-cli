// @fitness-ignore-file unbounded-memory -- reads pom.xml / build.gradle manifests; bounded by standard Java build metadata
/**
 * Java cacheKey implementation.
 *
 * Produces `java-${buildFileHash || 'no-config'}`.
 *
 * Java has no canonical resolved-dependency lock file like Cargo.lock
 * or go.sum. Maven's `pom.xml` and Gradle's `build.gradle` /
 * `build.gradle.kts` are the build-config sources of truth, so we
 * fingerprint those. Gradle does emit `gradle.lockfile` when locking
 * is enabled but it's opt-in; we treat it as preferred when present
 * since it captures the resolved versions.
 *
 * Precedence (most-resolved first):
 *   1. `gradle.lockfile`  — resolved deps when Gradle locking is on
 *   2. `pom.xml`          — Maven's source of truth
 *   3. `build.gradle.kts` — Gradle Kotlin DSL build config
 *   4. `build.gradle`     — Gradle Groovy DSL build config
 *
 * Per contract invariant I-6: pure function of `(config content)`.
 * Per I-8: emits `java-`, distinct from `rs-`, `py-`, `go-`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type { CacheKeyInput } from '@opensip-tools/graph';

export function cacheKey(input: CacheKeyInput): string {
  return `java-${hashConfig(input.configPathAbs)}`;
}

function hashConfig(configPathAbs: string | undefined): string {
  if (configPathAbs === undefined || configPathAbs.length === 0) {
    return 'no-config';
  }
  if (!existsSync(configPathAbs)) {
    return `missing:${configPathAbs}`;
  }
  try {
    const content = readFileSync(configPathAbs, 'utf8');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    /* v8 ignore next */
    return `unreadable:${configPathAbs}`;
  }
}
