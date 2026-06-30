import type { CliDiagnostic } from '../cli-diagnostic.js';

/** One row of the `tools list` effective-tool inventory (ADR-0041). */
export interface ToolsListRow {
  /** The tool's human id (from its manifest; package name when unreadable). */
  readonly id: string;
  /** The tool's stable UUID, when declared. */
  readonly stableId?: string;
  /** Alias for {@link stableId}, included for hand-authored suite config UX. */
  readonly uuid?: string;
  /** npm package name, when the tool is a package install. */
  readonly packageName?: string;
  readonly version: string;
  /** Where the tool comes from, in the user-facing vocabulary. */
  readonly source: 'bundled' | 'global' | 'project';
  /** Command names the manifest declares (names only — no runtime is loaded). */
  readonly commands: readonly string[];
  /**
   * `loaded` — admitted by THIS run's bootstrap; `manifest-only` — present on
   * disk (marker + manifest file read) but not loaded this run. `tools list`
   * never dynamic-imports a runtime, so this is as much as a listing can know.
   */
  readonly status: 'loaded' | 'manifest-only';
  /** Why the host trusted or denied this tool. */
  readonly trustReason?:
    | 'bundled'
    | 'managed-install'
    | 'project-config'
    | 'env'
    | 'user-global'
    | 'denied';
  /** True on a GLOBAL row whose tool id is shadowed by a project-local install. */
  readonly shadowed?: boolean;
}

/** Outcome of `opensip tools create <tool-id>`. */
export interface ToolsCreateResult {
  type: 'tools-create';
  readonly toolId: string;
  readonly dir: string;
  readonly files: readonly string[];
  readonly success: boolean;
  readonly template?: 'minimal-js' | 'ts-local';
  readonly nextSteps?: readonly string[];
  readonly error?: string;
  readonly hint?: string;
}

/** Outcome of `opensip tools list` (ADR-0041). */
export interface ToolsListResult {
  type: 'tools-list';
  tools: readonly ToolsListRow[];
  totalCount: number;
}

/** Outcome of `opensip tools doctor` (ADR-0060). */
export interface ToolsDoctorResult {
  type: 'tools-doctor';
  diagnostics: readonly CliDiagnostic[];
  totalCount: number;
}

/** One `tools validate` report section (ADR-0041 / ADR-0042 Tier A). */
export interface ToolsValidateSection {
  readonly name: string;
  /**
   * `skipped` = the section could not run AND that is expected (in-place path
   * validation without `--install-deps`); it still makes the overall verdict
   * `incomplete`, never `passed` — an unverified runtime is not a pass.
   */
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly diagnostics: readonly string[];
}

/** Outcome of `opensip tools validate <spec>` (ADR-0041). */
export interface ToolsValidateResult {
  type: 'tools-validate';
  readonly spec: string;
  readonly toolId?: string;
  readonly verdict: 'passed' | 'failed' | 'incomplete';
  readonly sections: readonly ToolsValidateSection[];
}

/** Outcome of `opensip tools install <spec>` (ADR-0041): stage → validate → activate. */
export interface ToolsInstallResult {
  type: 'tools-install';
  readonly spec: string;
  readonly success: boolean;
  /** The requested install scope. */
  readonly scope: 'global' | 'project';
  /** The full validation report the activation decision was made on. */
  readonly validation: ToolsValidateResult;
  readonly toolId?: string;
  readonly version?: string;
  readonly trustReason?: 'managed-install' | 'project-config' | 'env';
  readonly nextSteps?: readonly string[];
  /** Activation-step failure detail (validation failures live in `validation`). */
  readonly error?: string;
}

/** Outcome of `opensip tools data-purge <tool-id>` (ADR-0042): per-tool row counts. */
export interface ToolsDataPurgeResult {
  type: 'tools-data-purge';
  readonly toolId: string;
  readonly sessions: number;
  readonly baselineEntries: number;
  /** Whether a baseline existence marker was removed. */
  readonly baselineMeta: boolean;
  readonly stateRows: number;
}

/** Outcome of `opensip tools uninstall <name-or-id>` (ADR-0041). */
export interface ToolsUninstallResult {
  type: 'tools-uninstall';
  /** The id-or-package-name argument as given. */
  readonly target: string;
  readonly success: boolean;
  /** The resolved identity that was removed (displayed before deletion). */
  readonly removed?: {
    readonly id: string;
    readonly packageName: string;
    readonly scope: 'global' | 'project';
  };
  readonly error?: string;
}
