/**
 * @fileoverview Target type definitions for shared targeting.
 *
 * The targeting document shape (these types) is owned by `@opensip-cli/config`
 * as of 2.10.1 (ADR-0023) — targeting is cross-tool, not a fitness concern. The
 * generic targeting runtime (register/get/byTag, glob expansion, globalExcludes)
 * now lives in `@opensip-cli/targeting` and is consumed via the host-built
 * `scope.targets` (ADR-0037). Fitness keeps only the check-domain layer:
 * `findByScope`, the `checkOverrides` cross-validation, `resolveFilesForCheck`'s
 * 3-tier precedence, and the content `fileCache`. Re-exported here so the
 * engine's existing `./types.js` importers stay stable.
 */

export type {
  TargetConfig,
  Target,
  CheckTargetMap,
  PluginsConfig,
  TargetsConfig,
} from '@opensip-cli/config';
