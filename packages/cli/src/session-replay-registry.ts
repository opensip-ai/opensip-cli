// @fitness-ignore-file batch-operation-limits -- fromTools iterates the bounded, in-process tool registry (a handful of first-party + plugin tools registered for the run), not an unbounded external collection.
import {
  resolveToolHooks,
  type Tool,
  type ToolProvenance,
  type ToolRegistry,
  type ToolSessionRecord,
  type ToolSessionReplayContribution,
  type ToolShortId,
} from '@opensip-cli/core';

import { isExternalToolProvenance, provenanceRecordFor } from './bootstrap/tool-provenance.js';

import type { CommandResult, ToolSessionReplay } from '@opensip-cli/contracts';

/**
 * One tool's session-replay capability as the host consumes it. `replaySession`
 * may be ASYNC (ADR-0054 M4-F): for a BUNDLED tool it runs the tool's in-host
 * `replaySession` closure and resolves synchronously; for an EXTERNAL tool it
 * forks a HOOK worker that imports the untrusted runtime and runs the replay
 * there (its code never executes in the host process).
 */
export interface CliSessionReplayContribution {
  readonly tool: ToolShortId;
  readonly replaySession: (
    stored: ToolSessionRecord,
  ) => ToolSessionReplay<CommandResult> | Promise<ToolSessionReplay<CommandResult>>;
}

/**
 * The injected capability that runs an EXTERNAL tool's session replay
 * out-of-process (ADR-0054 M4-F). It is INJECTED (not statically imported) so
 * `session-replay-registry.ts` does not depend on the dispatch chain — which
 * would form a module cycle, because this module is a TYPE dependency of
 * `commands/shared.ts` that the dispatch chain transitively imports. The
 * composition root (`build-command-registration-input.ts`, a bootstrap module the
 * dispatch chain never imports) supplies the real implementation.
 */
export type ExternalReplayDispatcher = (
  provenance: ToolProvenance,
  stored: ToolSessionRecord,
) => Promise<unknown>;

/** Options for {@link SessionReplayRegistry.fromTools}. */
export interface SessionReplayRegistryOptions {
  /** The per-run provenance (drives the M4-F host/external gate). */
  readonly provenance?: readonly ToolProvenance[];
  /** Injected external-replay dispatcher (forks the replay HOOK worker). */
  readonly dispatchExternalReplay?: ExternalReplayDispatcher;
}

export class SessionReplayRegistry {
  private constructor(
    private readonly byTool: ReadonlyMap<ToolShortId, CliSessionReplayContribution>,
  ) {}

  static empty(): SessionReplayRegistry {
    return new SessionReplayRegistry(new Map());
  }

  /**
   * Build the registry from the tools' `sessionReplay` contributions, honoring the
   * ADR-0054 M4-F host/external split: a BUNDLED tool keeps its in-host replay
   * closure; an EXTERNAL tool gets a worker-backed replay (the host never runs the
   * external `replaySession` in-process) via the injected
   * {@link ExternalReplayDispatcher}.
   *
   * @throws {Error} when two registered tools claim the same `tool` short id.
   */
  static fromTools(
    registry: ToolRegistry,
    opts: SessionReplayRegistryOptions = {},
  ): SessionReplayRegistry {
    const provenance = opts.provenance ?? [];
    const byTool = new Map<ToolShortId, CliSessionReplayContribution>();
    for (const tool of registry.list()) {
      const contribution = resolveToolHooks(tool).sessionReplay;
      if (contribution === undefined) continue;
      if (byTool.has(contribution.tool)) {
        throw new Error(`Duplicate session replay contribution for tool '${contribution.tool}'`);
      }
      byTool.set(
        contribution.tool,
        isExternalToolProvenance(tool, provenance)
          ? externalContribution(tool, contribution, provenance, opts.dispatchExternalReplay)
          : bundledContribution(contribution),
      );
    }
    return new SessionReplayRegistry(byTool);
  }

  get(tool: ToolShortId): CliSessionReplayContribution | undefined {
    return this.byTool.get(tool);
  }
}

/** A BUNDLED tool replays in-host (trusted computing base) — the closure as-is. */
function bundledContribution(
  contribution: ToolSessionReplayContribution,
): CliSessionReplayContribution {
  return {
    tool: contribution.tool,
    replaySession: (stored) =>
      contribution.replaySession(stored) as ToolSessionReplay<CommandResult>,
  };
}

/**
 * An EXTERNAL tool replays via the injected dispatcher, which forks a HOOK worker
 * that imports the untrusted runtime and runs `sessionReplay.replaySession(stored)`
 * there, returning the `ToolSessionReplay` (plain data) over IPC. A fork failure
 * surfaces as a structured error to `sessions show` (fail loud — a replay the user
 * explicitly asked for must not silently return empty, and external code never
 * runs in-host).
 *
 * The returned `replaySession` closure @throws {Error} when the external tool
 * cannot be isolated (no provenance record, or no injected dispatcher), and
 * propagates a structured dispatch error when the replay worker fork fails — both
 * are surfaced to `sessions show` as a `decode-error` outcome, never a silent
 * empty replay or an in-host run.
 */
function externalContribution(
  tool: Tool,
  contribution: ToolSessionReplayContribution,
  provenance: readonly ToolProvenance[],
  dispatchExternalReplay: ExternalReplayDispatcher | undefined,
): CliSessionReplayContribution {
  return {
    tool: contribution.tool,
    replaySession: async (stored): Promise<ToolSessionReplay<CommandResult>> => {
      const record = provenanceRecordFor(tool, provenance);
      if (record === undefined || dispatchExternalReplay === undefined) {
        throw new Error(
          `external tool '${tool.metadata.name ?? tool.metadata.id}' session replay ` +
            'cannot be isolated (no provenance/dispatcher to fork the replay worker); refusing to run it in-process',
        );
      }
      const result = await dispatchExternalReplay(record, stored);
      return result as ToolSessionReplay<CommandResult>;
    },
  };
}
