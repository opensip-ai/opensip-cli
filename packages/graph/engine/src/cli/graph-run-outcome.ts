import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolSessionContribution } from '@opensip-cli/core';

/**
 * Truthful evidence returned by every completed static graph command path.
 *
 * Direct analyses always carry both evidence forms, independent of how their
 * presentation was requested. Workspace children intentionally carry only
 * their post-suppression envelope (the parent owns aggregate persistence and
 * egress), while the workspace parent carries only its aggregate session (there
 * is no truthful aggregate graph envelope to invent).
 */
export type GraphRunOutcome =
  | {
      readonly kind: 'direct';
      readonly envelope: SignalEnvelope;
      readonly session: ToolSessionContribution;
    }
  | {
      readonly kind: 'workspace-child';
      readonly envelope: SignalEnvelope;
      readonly session?: never;
    }
  | {
      readonly kind: 'workspace-parent';
      readonly session: ToolSessionContribution;
      readonly envelope?: never;
    };

/** Closed vocabulary for the graph completion event's delivery projection. */
export type GraphDeliveryMode =
  | 'gate'
  | 'catalog'
  | 'json'
  | 'human'
  | 'report-to'
  | 'workspace-parent';

type GraphCompletionLogInput =
  | {
      readonly kind: 'direct';
      readonly deliveryMode: Exclude<GraphDeliveryMode, 'workspace-parent'>;
    }
  | {
      readonly kind: 'workspace-child';
      readonly deliveryMode: 'json';
    }
  | {
      readonly kind: 'workspace-parent';
      readonly deliveryMode: 'workspace-parent';
    };

/** Stable, payload-free evidence fields stamped on graph completion events. */
export interface GraphCompletionLogFields {
  readonly deliveryMode: GraphDeliveryMode;
  readonly sessionContributed: boolean;
  readonly envelopeReturned: boolean;
  readonly workspaceChild: boolean;
}

export function graphCompletionLogFields(
  input: GraphCompletionLogInput,
): GraphCompletionLogFields {
  switch (input.kind) {
    case 'direct': {
      return {
        deliveryMode: input.deliveryMode,
        sessionContributed: true,
        envelopeReturned: true,
        workspaceChild: false,
      };
    }
    case 'workspace-child': {
      return {
        deliveryMode: input.deliveryMode,
        sessionContributed: false,
        envelopeReturned: true,
        workspaceChild: true,
      };
    }
    case 'workspace-parent': {
      return {
        deliveryMode: input.deliveryMode,
        sessionContributed: true,
        envelopeReturned: false,
        workspaceChild: false,
      };
    }
  }
}
