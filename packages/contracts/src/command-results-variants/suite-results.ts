export interface SuiteStepSummary {
  readonly tool: string;
  readonly stableId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly error?: string;
}

export interface SuiteRunResult {
  type: 'suite-run';
  readonly suite: string;
  readonly suiteRunId: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly steps: readonly SuiteStepSummary[];
}

export interface SuiteListStep {
  readonly tool: string;
  readonly stableId: string;
  readonly command: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface SuiteListEntry {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly SuiteListStep[];
}

export interface SuiteListResult {
  type: 'suite-list';
  readonly suites: readonly SuiteListEntry[];
  readonly totalCount: number;
}

export interface SuiteAddResult {
  type: 'suite-add';
  readonly suite: string;
  readonly tool: string;
  readonly stableId: string;
  readonly command: string;
  readonly configPath: string;
  readonly changed: boolean;
}
