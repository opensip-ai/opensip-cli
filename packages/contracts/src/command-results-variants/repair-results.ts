import type { SignalRepairAction, SignalRepairVerification } from '@opensip-cli/core';

export interface RepairSessionRef {
  readonly id: string;
  readonly tool: string;
  readonly cwd?: string;
}

export interface RepairSignalRef {
  readonly id: string;
  readonly ruleId: string;
  readonly message: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly fingerprint?: string;
}

export interface RepairActionRef {
  readonly id: string;
  readonly kind: SignalRepairAction['kind'];
  readonly title: string;
  readonly autofixable: boolean;
  readonly confidence?: number;
}

export interface RepairFileChange {
  readonly filePath: string;
  readonly status: 'modified' | 'unchanged';
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly diff: string;
}

export interface RepairRefusal {
  readonly code: string;
  readonly message: string;
}

export interface RepairPreviewResult {
  type: 'repair-preview';
  readonly status: 'previewed' | 'already-applied' | 'refused';
  readonly session: RepairSessionRef;
  readonly signal: RepairSignalRef;
  readonly action: RepairActionRef;
  readonly changes: readonly RepairFileChange[];
  readonly refusal?: RepairRefusal;
  readonly verification?: SignalRepairVerification;
}

export interface RepairApplyResult {
  type: 'repair-apply';
  readonly status: 'applied' | 'already-applied' | 'refused';
  readonly session: RepairSessionRef;
  readonly signal: RepairSignalRef;
  readonly action: RepairActionRef;
  readonly changes: readonly RepairFileChange[];
  readonly refusal?: RepairRefusal;
  readonly verification?: SignalRepairVerification;
}
