import { isPlainRecord, type Signal } from '@opensip-cli/core';

import type {
  RepairSignalRef,
  RepairVerificationCommand,
  RepairVerificationFailure,
  RepairVerificationFindingMatch,
  RepairVerificationResult,
  SignalEnvelope,
} from '@opensip-cli/contracts';

const MAX_FAILURE_MESSAGE_LENGTH = 500;

interface VerificationScopeInput {
  readonly tool: string;
  readonly ruleId: string;
  readonly files: readonly string[];
  readonly checkRan?: boolean;
  readonly fallback?: RepairVerificationResult['scope']['fallback'];
}

export interface BuildSkippedVerificationInput extends VerificationScopeInput {
  readonly status: 'skipped' | 'unverified';
  readonly command?: RepairVerificationCommand;
  readonly failure?: RepairVerificationFailure;
  readonly notes?: readonly string[];
}

export interface ClassifyVerificationInput extends VerificationScopeInput {
  readonly envelope: SignalEnvelope;
  readonly signal: RepairSignalRef;
  readonly command: RepairVerificationCommand;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

type VerificationTrust = NonNullable<SignalEnvelope['verification']>;

interface VerificationDecisionInput {
  readonly ruleId: string;
  readonly checkRan: boolean;
  readonly unitError?: string;
  readonly remainingFindingCount: number;
  readonly trust?: VerificationTrust;
  readonly exitCode: number | null;
  readonly sameRuleFindingCount: number;
}

interface VerificationDecision {
  readonly status: RepairVerificationResult['status'];
  readonly failure?: RepairVerificationFailure;
  readonly notes: readonly string[];
}

function truncateMessage(value: string): string {
  if (value.length <= MAX_FAILURE_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 3)}...`;
}

function failure(code: string, message: string): RepairVerificationFailure {
  return { code, message: truncateMessage(message) };
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== undefined && value !== '')),
  ];
}

function signalMatch(signal: Signal, selected: RepairSignalRef): boolean {
  if (selected.fingerprint !== undefined && signal.fingerprint === selected.fingerprint)
    return true;
  if (signal.ruleId !== selected.ruleId) return false;
  if (selected.filePath !== undefined && signal.filePath !== selected.filePath) return false;
  if (selected.line !== undefined && signal.line !== selected.line) return false;
  return true;
}

function findingMatch(signal: Signal): RepairVerificationFindingMatch {
  return {
    id: signal.id,
    ruleId: signal.ruleId,
    message: signal.message,
    ...(signal.filePath === '' ? {} : { filePath: signal.filePath }),
    ...(signal.line === undefined ? {} : { line: signal.line }),
    ...(signal.fingerprint === undefined ? {} : { fingerprint: signal.fingerprint }),
  };
}

function isSignalEnvelope(value: unknown): value is SignalEnvelope {
  return isPlainRecord(value) && Array.isArray(value.signals) && Array.isArray(value.units);
}

function envelopeFromOutcome(value: unknown): SignalEnvelope | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (isSignalEnvelope(value.envelope)) return value.envelope;
  if (isPlainRecord(value.data) && isSignalEnvelope(value.data.envelope)) {
    return value.data.envelope;
  }
  return undefined;
}

function emptyResult(input: BuildSkippedVerificationInput): RepairVerificationResult {
  return {
    status: input.status,
    coverage: 'unknown',
    scope: {
      tool: input.tool,
      ruleId: input.ruleId,
      files: uniqueStrings(input.files),
      checkRan: input.checkRan ?? false,
      changedImpacted: true,
      fallback: input.fallback ?? 'unknown',
    },
    commands: input.command === undefined ? [] : [input.command],
    remainingFindings: [],
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}

function partialVerificationNotes(input: {
  readonly trust?: VerificationTrust;
  readonly exitCode: number | null;
  readonly sameRuleFindingCount: number;
}): readonly string[] {
  const notes: string[] = [];
  if (input.trust === undefined) {
    notes.push('verification command did not report impact-trust metadata');
  } else if (!input.trust.fullyVerified) {
    notes.push(
      `impact verification was ${input.trust.coverage} with ${input.trust.fallback} fallback`,
    );
  }
  if (input.exitCode !== 0 && input.sameRuleFindingCount > 0) {
    notes.push('verification command still emitted findings for the same rule');
  } else if (input.exitCode !== 0) {
    notes.push(`verification command exited ${String(input.exitCode)}`);
  }
  return notes;
}

function decideVerification(input: VerificationDecisionInput): VerificationDecision {
  if (!input.checkRan) {
    return {
      status: 'partial',
      failure: failure(
        'verification-check-not-run',
        `verification output did not include check '${input.ruleId}'`,
      ),
      notes: [],
    };
  }
  if (input.unitError !== undefined) {
    return {
      status: 'unverified',
      failure: failure('verification-check-error', input.unitError),
      notes: [],
    };
  }
  if (input.remainingFindingCount > 0) {
    return {
      status: 'unverified',
      failure: failure('verification-finding-remains', 'the selected finding is still present'),
      notes: [],
    };
  }
  if (input.trust?.fullyVerified === true && input.exitCode === 0) {
    return { status: 'verified', notes: [] };
  }
  return {
    status: 'partial',
    notes: partialVerificationNotes({
      ...(input.trust === undefined ? {} : { trust: input.trust }),
      exitCode: input.exitCode,
      sameRuleFindingCount: input.sameRuleFindingCount,
    }),
  };
}

export function skippedVerification(input: Omit<BuildSkippedVerificationInput, 'status'>) {
  return emptyResult({ ...input, status: 'skipped' });
}

export function unverifiedWithoutRun(input: Omit<BuildSkippedVerificationInput, 'status'>) {
  return emptyResult({ ...input, status: 'unverified' });
}

export function parseVerificationEnvelope(
  stdout: string,
):
  | { readonly ok: true; readonly envelope: SignalEnvelope }
  | { readonly ok: false; readonly failure: RepairVerificationFailure } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return {
      ok: false,
      failure: failure('verification-json-invalid', 'verification output was not valid JSON'),
    };
  }
  if (!isPlainRecord(parsed)) {
    return {
      ok: false,
      failure: failure('verification-json-invalid', 'verification output was not an object'),
    };
  }
  const envelope = envelopeFromOutcome(parsed);
  if (envelope === undefined) {
    return {
      ok: false,
      failure: failure(
        'verification-envelope-missing',
        'verification output did not include an envelope',
      ),
    };
  }
  return { ok: true, envelope };
}

export function classifyVerification(input: ClassifyVerificationInput): RepairVerificationResult {
  const unit = input.envelope.units.find((candidate) => candidate.slug === input.ruleId);
  const checkRan = unit !== undefined;
  const remainingFindings = input.envelope.signals
    .filter((signal) => signalMatch(signal, input.signal))
    .map(findingMatch);
  const trust = input.envelope.verification;
  const coverage = trust?.coverage ?? 'unknown';
  const fallback = trust?.fallback ?? 'unknown';
  const sameRuleFindings = input.envelope.signals.filter(
    (signal) => signal.ruleId === input.ruleId,
  );
  const decision = decideVerification({
    ruleId: input.ruleId,
    checkRan,
    ...(unit?.error === undefined ? {} : { unitError: unit.error }),
    remainingFindingCount: remainingFindings.length,
    ...(trust === undefined ? {} : { trust }),
    exitCode: input.exitCode,
    sameRuleFindingCount: sameRuleFindings.length,
  });

  return {
    status: decision.status,
    coverage,
    scope: {
      tool: input.tool,
      ruleId: input.ruleId,
      files: uniqueStrings(input.files),
      checkRan,
      changedImpacted: true,
      fallback,
    },
    commands: [input.command],
    remainingFindings,
    ...(trust === undefined ? {} : { trust }),
    durationMs: input.durationMs,
    ...(decision.failure === undefined ? {} : { failure: decision.failure }),
    ...(decision.notes.length === 0 ? {} : { notes: decision.notes }),
  };
}

export function verificationFailure(code: string, message: string): RepairVerificationFailure {
  return failure(code, message);
}
