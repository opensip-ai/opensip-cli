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
    /**
     * When absent/false (the default) a step that FAULTED (a runtime error — a
     * unit threw/timed-out) does NOT fail the suite exit: the fault is surfaced
     * in the aggregate counts + review brief but is non-blocking, so a crash is
     * distinct from a findings failure (which still fails). Set true to make a
     * runtime fault hard-fail the suite. Optional (no schema default) so existing
     * execution literals stay valid; the false default is applied at the read
     * site in the orchestrator.
     */
    failOnFault: z.boolean().optional(),
  })
  .strict()
  .optional()
  .describe(
    'Suite execution policy: failOnFault (live); mode/stopOnFirstFailure reserved for v1+.',
  );

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
