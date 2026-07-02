import type { ImpactTrust, ImpactTrustCoverage } from '../impact-trust.js';
import type {
  RepairActionRef,
  RepairApplyResult,
  RepairFileChange,
  RepairRefusal,
  RepairSessionRef,
  RepairSignalRef,
} from './repair-results.js';
import type { SignalRepairVerification } from '@opensip-cli/core';

export type RepairVerificationStatus = 'verified' | 'unverified' | 'partial' | 'skipped';

export type RepairVerificationCoverage = ImpactTrustCoverage;

export interface RepairVerificationCommand {
  readonly tool: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly check?: string;
}

export interface RepairVerificationFindingMatch {
  readonly id: string;
  readonly ruleId: string;
  readonly message: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly fingerprint?: string;
}

export interface RepairVerificationScope {
  readonly tool: string;
  readonly ruleId: string;
  readonly files: readonly string[];
  readonly checkRan: boolean;
  readonly changedImpacted: boolean;
  readonly fallback: ImpactTrust['fallback'] | 'unknown';
}

export interface RepairVerificationFailure {
  readonly code: string;
  readonly message: string;
}

export interface RepairVerificationResult {
  readonly status: RepairVerificationStatus;
  readonly coverage: RepairVerificationCoverage;
  readonly scope: RepairVerificationScope;
  readonly commands: readonly RepairVerificationCommand[];
  readonly remainingFindings: readonly RepairVerificationFindingMatch[];
  readonly trust?: ImpactTrust;
  readonly durationMs?: number;
  readonly failure?: RepairVerificationFailure;
  readonly notes?: readonly string[];
}

export interface RepairApplyVerifyResult {
  readonly type: 'repair-apply-verify';
  readonly status: RepairApplyResult['status'];
  readonly session: RepairSessionRef;
  readonly signal: RepairSignalRef;
  readonly action: RepairActionRef;
  readonly changes: readonly RepairFileChange[];
  readonly force: boolean;
  readonly refusal?: RepairRefusal;
  readonly verificationGuidance?: SignalRepairVerification;
  readonly verification: RepairVerificationResult;
}
