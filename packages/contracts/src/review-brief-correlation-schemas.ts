import { z } from 'zod';

export const reviewBriefEntityRefSchema = z
  .object({
    kind: z.enum(['fingerprint', 'file', 'file-range', 'symbol', 'graph-node', 'package']),
    id: z.string(),
    confidence: z.enum(['low', 'medium', 'high']),
    label: z.string().optional(),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    source: z.string().optional(),
  })
  .strict();

export const reviewBriefCorrelationKeySchema = z
  .object({
    kind: z.enum([
      'fingerprint',
      'graph-node',
      'symbol',
      'rule-location',
      'file-range',
      'package',
      'file',
    ]),
    value: z.string(),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

export const reviewBriefCorrelationReasonSchema = z
  .object({
    kind: z.enum([
      'same-fingerprint',
      'same-graph-node',
      'same-symbol',
      'same-rule-location',
      'same-file-range',
      'same-package',
      'same-file',
    ]),
    key: reviewBriefCorrelationKeySchema,
    confidence: z.enum(['low', 'medium', 'high']),
    message: z.string(),
  })
  .strict();

const reviewBriefSignalRefProjectionSchema = z
  .object({
    tool: z.string(),
    suiteRunId: z.string(),
    stepIndex: z.number().int().nonnegative(),
    runId: z.string().optional(),
    fingerprint: z.string().optional(),
    signalIndex: z.number().int().nonnegative(),
  })
  .strict();

export const reviewBriefRiskRefSchema = z
  .object({
    source: z.string(),
    ruleId: z.string(),
    file: z.string(),
    signalRef: reviewBriefSignalRefProjectionSchema,
    line: z.number().int().positive().optional(),
    column: z.number().int().nonnegative().optional(),
  })
  .strict();

export const reviewBriefCorrelationGroupSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    isNew: z.boolean(),
    primary: reviewBriefRiskRefSchema,
    members: z.array(reviewBriefRiskRefSchema),
    entities: z.array(reviewBriefEntityRefSchema),
    reasons: z.array(reviewBriefCorrelationReasonSchema),
    blastRadius: z
      .object({
        dependents: z.number().int().nonnegative(),
        confidence: z.enum(['low', 'medium', 'high']),
        impactedFiles: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
