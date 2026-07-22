import { z } from 'zod';

/**
 * Suite names reserved for host-owned built-in suites (ADR-0159). A configured
 * suite may not claim one, so a built-in workflow cannot diverge from generic
 * `suite run <name>` resolution. Rejecting the key at document validation makes
 * shadowing unrepresentable. Bundling a new built-in suite requires adding its
 * name here in the same change.
 */
export const RESERVED_SUITE_NAMES = ['audit', 'agent-context'] as const;

const reservedSuiteNames: ReadonlySet<string> = new Set(RESERVED_SUITE_NAMES);
const suiteNameSchema = z.string().trim().min(1);

function hasPrototypeMagicSuiteName(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, '__proto__')
  );
}

/** True when `name` is reserved for a built-in suite (ADR-0159). */
export function isReservedSuiteName(name: string): boolean {
  return reservedSuiteNames.has(name);
}

/** Actionable rejection message for a reserved suite name, with a rename hint. */
export function reservedSuiteNameMessage(name: string): string {
  return (
    `Suite name '${name}' is reserved for the built-in ${name} suite (ADR-0159). ` +
    `Rename the configured suite (for example '${name}-custom') and run it with: ` +
    `opensip suite run ${name}-custom`
  );
}

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
  // Zod's record parser deliberately omits `__proto__` before key validation,
  // which would otherwise turn a configured suite into a successful empty
  // record. Inspect the raw mapping before record parsing loses that key.
  .unknown()
  .refine((value) => !hasPrototypeMagicSuiteName(value), {
    message: 'suite name __proto__ is not supported',
  })
  .pipe(z.record(suiteNameSchema, suiteDefinitionSchema))
  .superRefine((suites, ctx) => {
    for (const name of Object.keys(suites)) {
      if (!reservedSuiteNames.has(name)) continue;
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: reservedSuiteNameMessage(name),
      });
    }
  })
  .default({});

/** One UUID-addressed tool command invocation inside a configured suite. */
export type SuiteStep = z.infer<typeof suiteStepSchema>;

/** A host-owned suite definition containing serial command steps. */
export type SuiteDefinition = z.infer<typeof suiteDefinitionSchema>;

/** Project-level map of configured suites keyed by suite name. */
export type SuitesConfig = z.infer<typeof suitesConfigSchema>;
