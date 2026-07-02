import type {
  RepairActionRef,
  RepairFileChange,
  RepairRefusal,
  RepairSessionRef,
  RepairSignalRef,
} from '@opensip-cli/contracts';
import type { Signal, SignalRepairAction } from '@opensip-cli/core';

export interface RepairError {
  readonly code: string;
  readonly message: string;
}

export interface SelectedRepairAction {
  readonly signal: Signal;
  readonly action: SignalRepairAction;
}

export interface RepairPlannedFileChange extends RepairFileChange {
  readonly absolutePath: string;
  readonly afterContent: string;
}

export interface RepairPlan {
  readonly status: 'previewed' | 'already-applied' | 'refused';
  readonly session: RepairSessionRef;
  readonly signal: RepairSignalRef;
  readonly action: RepairActionRef;
  readonly changes: readonly RepairPlannedFileChange[];
  readonly refusal?: RepairRefusal;
  readonly verification?: SignalRepairAction['verification'];
}

export interface RepairBuildInput {
  readonly projectRoot: string;
  readonly session: {
    readonly id: string;
    readonly tool: string;
    readonly cwd?: string;
  };
  readonly signals: readonly Signal[];
  readonly selector: string;
  readonly actionId?: string;
}
