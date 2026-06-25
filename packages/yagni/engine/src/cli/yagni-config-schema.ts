/**
 * yagni-config-schema — the YAGNI tool's namespaced Zod config schema.
 *
 * Mirrors {@link YagniConfig} one-for-one. Gate keys (`failOnErrors` /
 * `failOnWarnings`) default to `0` so advisory findings never fail the run.
 */

import { z } from 'zod';

import type { YagniConfig } from '../types/yagni-config.js';
import type { ToolConfigDeclaration } from '@opensip-cli/config';

const confidenceLevel = z.enum(['low', 'medium', 'high']);

export const YagniConfigSchema = z
  .object({
    failOnErrors: z.number().int().min(0).optional(),
    failOnWarnings: z.number().int().min(0).optional(),
    defaultMinConfidence: confidenceLevel.optional(),
    includeTests: z.boolean().optional(),
    disabledDetectors: z.array(z.string().min(1)).readonly().optional(),
    detectorSettings: z.record(z.string(), z.record(z.string(), z.unknown())).readonly().optional(),
  })
  .strict();

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
    includeTests: false,
  },
  env: [
    { envVar: 'OPENSIP_YAGNI_MIN_CONFIDENCE', key: 'defaultMinConfidence' },
    {
      envVar: 'OPENSIP_YAGNI_INCLUDE_TESTS',
      key: 'includeTests',
      type: 'boolean',
    },
  ],
};
