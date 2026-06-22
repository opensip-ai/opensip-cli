/**
 * yagni-config-schema — the YAGNI tool's namespaced Zod config schema.
 *
 * Mirrors {@link YagniConfig} one-for-one. Gate keys (`failOnErrors` /
 * `failOnWarnings`) default to `0` so advisory findings never fail the run.
 */

import { z } from 'zod';

import type { YagniConfig } from '../types/yagni-config.js';
import type { ToolConfigDeclaration } from '@opensip-cli/config';

const graphMode = z.enum(['auto', 'reuse', 'build', 'off']);

export const YagniConfigSchema = z.object({
  failOnErrors: z.number().int().min(0).optional(),
  failOnWarnings: z.number().int().min(0).optional(),
  defaultMinConfidence: z.number().min(0).max(1).optional(),
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
    defaultMinConfidence: 0.5,
    graphMode: 'auto',
    includeTests: false,
  },
  env: [
    { envVar: 'OPENSIP_YAGNI_GRAPH_MODE', key: 'graphMode' },
    { envVar: 'OPENSIP_YAGNI_DEFAULT_MIN_CONFIDENCE', key: 'defaultMinConfidence', type: 'number' },
    { envVar: 'OPENSIP_YAGNI_INCLUDE_TESTS', key: 'includeTests', type: 'boolean' },
  ],
};