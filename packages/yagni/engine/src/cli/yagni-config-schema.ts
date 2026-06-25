/**
 * yagni-config-schema — the YAGNI tool's namespaced Zod config schema.
 *
 * Mirrors {@link YagniConfig} one-for-one. Gate keys (`failOnErrors` /
 * `failOnWarnings`) default to `0` so advisory findings never fail the run.
 */

import { z } from 'zod';

import type { YagniConfig } from '../types/yagni-config.js';
import type { ToolConfigDeclaration } from '@opensip-cli/config';

// Deprecated (ADR-0063, v0.1.12): yagni no longer builds or reuses a graph.
// Still accepted (so existing config files keep validating) but inert; the
// command warns when `--graph` is passed. Slated for removal in 0.1.13.
const graphMode = z.enum(['auto', 'reuse', 'build', 'off']);
const confidenceLevel = z.enum(['low', 'medium', 'high']);

export const YagniConfigSchema = z.object({
  failOnErrors: z.number().int().min(0).optional(),
  failOnWarnings: z.number().int().min(0).optional(),
  defaultMinConfidence: confidenceLevel.optional(),
  // Deprecated & inert since v0.1.12 — duplicate analysis moved to `opensip graph`.
  graphMode: graphMode.optional(),
  includeTests: z.boolean().optional(),
  disabledDetectors: z.array(z.string().min(1)).readonly().optional(),
  detectorSettings: z.record(z.string(), z.record(z.string(), z.unknown())).readonly().optional(),
});

type SchemaOut = z.infer<typeof YagniConfigSchema>;
type AssertMutual<A, B> = A extends B ? (B extends A ? true : never) : never;
declare const _yagniConfigLockstep: AssertMutual<SchemaOut, YagniConfig>;

export const yagniConfigDeclaration: ToolConfigDeclaration = {
  namespace: 'yagni',
  schema: YagniConfigSchema,
  defaults: {
    failOnErrors: 0,
    failOnWarnings: 0,
    defaultMinConfidence: 'medium',
    graphMode: 'auto',
    includeTests: false,
  },
  env: [
    // Deprecated v0.1.12 (inert) — kept so existing environments don't error.
    { envVar: 'OPENSIP_YAGNI_GRAPH_MODE', key: 'graphMode' },
    { envVar: 'OPENSIP_YAGNI_MIN_CONFIDENCE', key: 'defaultMinConfidence' },
    {
      envVar: 'OPENSIP_YAGNI_INCLUDE_TESTS',
      key: 'includeTests',
      type: 'boolean',
    },
  ],
};
