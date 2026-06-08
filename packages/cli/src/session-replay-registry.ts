import type { CommandResult, ToolSessionReplay } from '@opensip-tools/contracts';
import type {
  ToolRegistry,
  ToolSessionRecord,
  ToolSessionReplayContribution,
  ToolShortId,
} from '@opensip-tools/core';

export interface CliSessionReplayContribution {
  readonly tool: ToolShortId;
  readonly replaySession: (stored: ToolSessionRecord) => ToolSessionReplay<CommandResult>;
}

export class SessionReplayRegistry {
  private constructor(private readonly byTool: ReadonlyMap<ToolShortId, CliSessionReplayContribution>) {}

  static empty(): SessionReplayRegistry {
    return new SessionReplayRegistry(new Map());
  }

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
