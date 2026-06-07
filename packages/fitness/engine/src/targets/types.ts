/**
 * @fileoverview Target type definitions for shared targeting.
 *
 * The targeting document shape (these types) is owned by `@opensip-tools/config`
 * as of 2.10.1 (ADR-0023) — targeting is cross-tool, not a fitness concern.
 * Fitness keeps the runtime (`TargetRegistry`, `resolveTargetFiles`); it
 * consumes the shape from the config layer. Re-exported here so the engine's
 * existing `./types.js` importers stay stable.
 */

export type {
  TargetConfig,
  Target,
  CheckTargetMap,
  PluginsConfig,
  TargetsConfig,
} from '@opensip-tools/config';
