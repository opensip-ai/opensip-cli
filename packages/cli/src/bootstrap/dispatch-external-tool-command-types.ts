import type { DispatchHostCtx } from './dispatch-replay-result.js';
import type { ToolProvenance } from '@opensip-cli/core';
import type { ExternalAdapterProgressEvent } from '@opensip-cli/external-tool-adapter';

export interface DispatchExternalToolCommandArgs {
  /** The external tool's provenance (source must NOT be `'bundled'`). */
  readonly provenance: ToolProvenance;
  /** Which command (by `CommandSpec.name`) to run in the worker. */
  readonly commandName: string;
  /** Parsed opts for this invocation (serializable). */
  readonly opts: Record<string, unknown>;
  /** Trailing positionals (`_args`) for this invocation (serializable). */
  readonly positionals: readonly unknown[];
  /**
   * The tool's RAW config namespace block for the WORKER deep pass (ADR-0054
   * M4-E Config two-pass). Forwarded into the spec so the worker runs the tool's
   * real Zod after load. `undefined` when there is no block to validate.
   */
  readonly config?: unknown;
  /** The real host context the supervisor replays the worker result through. */
  readonly ctx: DispatchHostCtx;
  /** Override the wall-clock timeout (tests use a short one). */
  readonly timeoutMs?: number;
  readonly presentationMode?: 'static' | 'adapter-live';
  readonly onAdapterProgress?: (event: ExternalAdapterProgressEvent) => void;
  readonly allowAdapterLiveView?: boolean;
  /**
   * Override the CLI entry script the supervisor forks (defaults to
   * `process.argv[1]`). The worker runs as `node <cliScript> __tool-command-worker
   * <specPath> --cwd <cwd>`, going through the full bootstrap so the dispatched
   * tool's scope (config/registries/subscope) is worker-local (ADR-0054 M4-E).
   * Tests point this at the built CLI dist entry.
   */
  readonly cliScript?: string;
}
