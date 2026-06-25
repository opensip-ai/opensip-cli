import { describe, expect, it } from 'vitest';

import { startWorkerHeartbeat, type WorkerHeartbeatMessage } from '../worker-heartbeat.js';

describe('startWorkerHeartbeat', () => {
  it('emits heartbeat messages until stopped', async () => {
    const messages: WorkerHeartbeatMessage[] = [];
    const stop = startWorkerHeartbeat({
      intervalMs: 10,
      send: (msg) => {
        messages.push(msg);
      },
    });
    await new Promise((r) => setTimeout(r, 35));
    stop();
    const countAtStop = messages.length;
    await new Promise((r) => setTimeout(r, 25));
    expect(countAtStop).toBeGreaterThan(0);
    expect(messages).toHaveLength(countAtStop);
    expect(messages.every((msg) => msg.kind === 'heartbeat')).toBe(true);
  });
});
