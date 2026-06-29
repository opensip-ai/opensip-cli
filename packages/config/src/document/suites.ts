import { z } from 'zod';

export const suiteStepArgsSchema = z.record(z.string(), z.unknown()).default({});

export const suiteStepSchema = z
  .object({
    tool: z.uuid(),
    name: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1),
    args: suiteStepArgsSchema.optional(),
    cwd: z
      .unknown()
      .optional()
      .describe('Reserved for future per-step scope support; rejected in v1.'),
  })
  .strict();

export const suiteExecutionSchema = z
  .object({
    mode: z.unknown().optional(),
    stopOnFirstFailure: z.unknown().optional(),
  })
  .strict()
  .optional()
  .describe('Reserved for future suite execution modes; rejected in v1.');

export const suiteDefinitionSchema = z
  .object({
    description: z.string().trim().min(1).optional(),
    steps: z.array(suiteStepSchema).min(1),
    execution: suiteExecutionSchema,
  })
  .strict();

export const suitesConfigSchema = z
  .record(z.string().trim().min(1), suiteDefinitionSchema)
  .default({});

/** One UUID-addressed tool command invocation inside a configured suite. */
export type SuiteStep = z.infer<typeof suiteStepSchema>;

/** A host-owned suite definition containing serial command steps. */
export type SuiteDefinition = z.infer<typeof suiteDefinitionSchema>;

/** Project-level map of configured suites keyed by suite name. */
export type SuitesConfig = z.infer<typeof suitesConfigSchema>;
