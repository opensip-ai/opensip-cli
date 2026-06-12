// @fitness-ignore-file batch-operation-limits -- fromTools iterates the bounded, in-process tool registry (a handful of first-party + plugin tools registered for the run), not an unbounded external collection.
import type { CommandResult, ToolSessionReplay } from '@opensip-cli/contracts';
import type {
  ToolRegistry,
  ToolSessionRecord,
  ToolSessionReplayContribution,
  ToolShortId,
} from '@opensip-cli/core';

export interface CliSessionReplayContribution {
  readonly tool: ToolShortId;
  readonly replaySession: (stored: ToolSessionRecord) => ToolSessionReplay<CommandResult>;
}

export class SessionReplayRegistry {
  private constructor(
    private readonly byTool: ReadonlyMap<ToolShortId, CliSessionReplayContribution>,
  ) {}

  static empty(): SessionReplayRegistry {
    return new SessionReplayRegistry(new Map());
  }

  /**
   * Build the registry from the tools' `sessionReplay` contributions.
   *
   * @throws {Error} when two registered tools claim the same `tool` short id
   *   (a duplicate session-replay contribution).
   */
  static fromTools(registry: ToolRegistry): SessionReplayRegistry {
    const byTool = new Map<ToolShortId, CliSessionReplayContribution>();
    for (const tool of registry.list()) {
      const contribution = tool.sessionReplay;
      if (contribution === undefined) continue;
      if (byTool.has(contribution.tool)) {
        throw new Error(`Duplicate session replay contribution for tool '${contribution.tool}'`);
      }
      byTool.set(contribution.tool, normalizeContribution(contribution));
    }
    return new SessionReplayRegistry(byTool);
  }

  get(tool: ToolShortId): CliSessionReplayContribution | undefined {
    return this.byTool.get(tool);
  }
}

function normalizeContribution(
  contribution: ToolSessionReplayContribution,
): CliSessionReplayContribution {
  return {
    tool: contribution.tool,
    replaySession: (stored) =>
      contribution.replaySession(stored) as ToolSessionReplay<CommandResult>,
  };
}
