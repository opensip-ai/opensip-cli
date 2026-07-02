import { generatePrefixedId } from '@opensip-cli/core';

import type { PolicyAuditEvent } from '@opensip-cli/config';

export interface BufferedPolicyAuditEvent extends PolicyAuditEvent {
  readonly id: string;
  readonly runId?: string;
}

export class PolicyAuditCollector {
  private readonly events: BufferedPolicyAuditEvent[] = [];

  constructor(private readonly runId?: string) {}

  record(event: PolicyAuditEvent): void {
    this.events.push({
      ...event,
      id: generatePrefixedId('policy_audit'),
      ...(this.runId === undefined ? {} : { runId: this.runId }),
    });
  }

  merge(other: PolicyAuditCollector): void {
    this.events.push(
      ...other
        .drain()
        .map((event) =>
          this.runId === undefined || event.runId !== undefined
            ? event
            : { ...event, runId: this.runId },
        ),
    );
  }

  drain(): readonly BufferedPolicyAuditEvent[] {
    return this.events.splice(0);
  }

  list(): readonly BufferedPolicyAuditEvent[] {
    return [...this.events];
  }
}

export function isPolicyAuditCollector(value: unknown): value is PolicyAuditCollector {
  return value instanceof PolicyAuditCollector;
}
