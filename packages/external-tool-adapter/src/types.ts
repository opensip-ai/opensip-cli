/**
 * @fileoverview Shared contract types for the External Tool Adapter substrate
 * (ADR-0090 / ADR-0091 / ADR-0092).
 *
 * An "external tool adapter" wraps a user-installed CLI scanner (gitleaks,
 * osv-scanner, trivy, …) as an ordinary opensip-cli `Tool`. The author declares
 * identity + a binary + per-command descriptors; the substrate owns the run
 * loop (resolve → execFile → capture → interpret exit → ingest → normalize →
 * persist), the standardized `doctor`/`version` commands, and provenance.
 *
 * These are pure data shapes — no runtime, no IO — so the file is a kernel-safe
 * type surface the rest of the substrate imports.
 */

import type {
  Logger,
  Signal,
  SignalSeverity,
  ToolConfigContribution,
  ToolIdentity,
} from '@opensip-cli/core';

/**
 * The network posture an adapter declares (ADR-0092). The host displays it
 * (`doctor`, `tools list`) and forward-maps it onto `opensipTools.requires`
 * (`subprocess` + `filesystem` always; `network` when networked/auth). Declaration
 * + display only in v1 — enforcement inherits spec 03 Gate A.
 */
export type NetworkPosture = 'local-only' | 'networked' | 'auth-required';

/** The native output shape a scanner command produces. */
export type ScannerOutputKind = 'sarif' | 'json' | 'stdout';

/**
 * Per-command exit-code model (ADR-0091). Separates "scanner found problems"
 * (a verdict) from "scanner broke" (a fault). Interpreted by {@link interpretExit}.
 */
export interface ScannerExitModel {
  /** Clean run, no findings (e.g. `[0]`). */
  readonly ok: readonly number[];
  /** Ran fine, found issues (e.g. `[1]`) — NOT a fault. */
  readonly findings: readonly number[];
  /** `>= this` ⇒ a genuine scanner error (e.g. `2`). Any unmodeled nonzero is also a fault. */
  readonly errorFrom?: number;
}

/**
 * How the substrate resolves the scanner binary (ADR-0090 §4.3): a layered,
 * deterministic order, first hit wins. `config` reads the operator pin
 * (`binaries.<tool>.path` in the namespaced config or the `OPENSIP_<TOOL>_BIN`
 * env var); `path` is the system `PATH` lookup. A missing binary yields a
 * `doctor` install hint, never a fetch.
 */
export type BinaryResolutionLayer = 'config' | 'env' | 'path';

/** The wrapped-binary declaration. */
export interface BinarySpec {
  /** PATH lookup name (e.g. `'gitleaks'`). */
  readonly command: string;
  /** Args that print the version (e.g. `['version']`), for `doctor` + provenance. */
  readonly versionArgs: readonly string[];
  /** Parse the version stdout to a semver-ish string. Defaults to `stdout.trim()`. */
  readonly versionParse?: (stdout: string) => string;
  /** `doctor` warns when the resolved version is below this. */
  readonly minVersion?: string;
  /** Resolution order (default `['config', 'path']`). */
  readonly resolution?: readonly Exclude<BinaryResolutionLayer, 'env'>[];
  /**
   * Env var that pins the binary path. Defaults to `OPENSIP_<TOOL>_BIN`
   * (uppercased identity name, `-`→`_`).
   */
  readonly envVar?: string;
  /** Platform-agnostic install hint surfaced by `doctor` when the binary is missing. */
  readonly installHint?: string;
}

/** The parsed native scanner output handed to a command's `parse`. */
export interface ParsedScannerOutput {
  readonly kind: ScannerOutputKind;
  /** Raw bytes/text exactly as the scanner wrote them. */
  readonly raw: string;
  /** Parsed JSON value when `kind` is `'json'`/`'sarif'` and parsing succeeded. */
  readonly json?: unknown;
}

/**
 * The resolved, per-run context the substrate hands a command's `args(ctx)` /
 * `parse(raw, ctx)` (ADR-0090 §4.2 / Phase-0 decision 8). Built from the
 * `ToolCliContext` with NO `cli` import (paths via core `resolveProjectPaths`).
 */
export interface AdapterRunContext {
  /** The adapter's identity name (`'gitleaks'`). */
  readonly tool: string;
  /** The adapter's npm package name, stamped into provenance. */
  readonly adapterPackage?: string;
  /** The resolved targeting root the scanner runs against. */
  readonly projectRoot: string;
  /** This invocation's run id (the artifact run-segment, ADR-0091). */
  readonly runId: string;
  /** The shared structured logger. */
  readonly logger: Logger;
  /** The adapter's resolved, namespaced config block (`scope.toolConfig?.<tool>`). */
  readonly config: Readonly<Record<string, unknown>>;
  /** The resolved binary (path/layer/version). */
  readonly binary: ResolvedBinary;
  /** The config file path (when one was read), for provenance. */
  readonly configPath?: string;
  /** Resolve a host-owned artifact path under `.runtime/artifacts/<tool>/<runId>/<name>`. */
  artifactPath(name: string): string;
}

/** A successfully resolved scanner binary. */
export interface ResolvedBinary {
  readonly path: string;
  readonly layer: BinaryResolutionLayer;
  readonly version?: string;
}

/**
 * One scanner command descriptor. The substrate owns the run loop; the author
 * supplies args + (for non-SARIF) a `parse`.
 */
export interface ExternalCommandSpec {
  /** The verb (`'scan'` is the conventional primary). */
  readonly name: string;
  readonly description?: string;
  /** Build the scanner argv (no shell). */
  readonly args: (ctx: AdapterRunContext) => readonly string[];
  /** Where the scanner writes its native output. `path` is the artifact basename for file outputs. */
  readonly output: { readonly kind: ScannerOutputKind; readonly path?: string };
  /** The exit-code model. Defaults to `{ ok: [0], findings: [1], errorFrom: 2 }`. */
  readonly exitCodes?: ScannerExitModel;
  /**
   * Native output → normalized signals. A `'sarif'` command MAY omit this — the
   * substrate's shared `ingestSarif` handles it.
   */
  readonly parse?: (raw: ParsedScannerOutput, ctx: AdapterRunContext) => readonly Signal[];
  /** Optional raw-label → severity overrides consulted by the adapter's `parse`. */
  readonly severityMap?: Readonly<Record<string, SignalSeverity>>;
}

/**
 * The fingerprint strategy choice (ADR-0091 §4.5). `message-hash` is the adapter
 * default (line-shift tolerant — scanner output is line-volatile). Stamped
 * worker-side when the envelope is built; the host ratchet only reads
 * `signal.fingerprint`.
 */
export type FingerprintStrategyChoice = 'message-hash' | 'rule-location';

/** The author surface of {@link defineExternalToolAdapter}. */
export interface ExternalToolAdapterSpec {
  readonly identity: ToolIdentity;
  readonly metadata: {
    /** Stable UUID (ADR-0048). */
    readonly id: string;
    readonly description: string;
    /** Package version stamped into the Tool metadata + provenance. Defaults to `'0.0.0'`. */
    readonly version?: string;
    /** npm package name for provenance (e.g. `'@opensip-cli/tool-gitleaks'`). */
    readonly adapterPackage?: string;
  };
  readonly binary: BinarySpec;
  readonly network: NetworkPosture;
  readonly commands: readonly ExternalCommandSpec[];
  /** Adapter default `'message-hash'` (ADR-0091 §4.5). */
  readonly fingerprintStrategy?: FingerprintStrategyChoice;
  /** Optional namespaced config contribution (e.g. the `binaries.<tool>.path` block). */
  readonly config?: Omit<ToolConfigContribution, 'namespace'>;
  /** Optional per-tool contract version marker (ADR-0046). */
  readonly contractVersion?: string;
}

/** Adapter provenance stamped onto every signal's `metadata.provenance` (ADR-0090 §8). */
export interface AdapterProvenance {
  readonly tool: string;
  readonly adapterPackage?: string;
  readonly binaryPath: string;
  readonly binaryVersion?: string;
  readonly args: readonly string[];
  readonly configPath?: string;
}

/**
 * A serializable command shell — the data a generator writes into an adapter's
 * `package.json#opensipTools.commands` so the static manifest matches the
 * runtime `commandSpecs` (the `assertCommandNamesMatch` parity mechanism).
 */
export interface ManifestCommandShell {
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly commonFlags: readonly string[];
  readonly scope: 'project' | 'none';
  readonly output: string;
  readonly parent?: string;
  readonly rawStreamReason?: string;
}
