import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

import {
  BoundedStdioClientTransport,
  createDefaultMcpConnector,
} from '../platform-acceptance/mcp-connector.mjs';
import { createParentSignalCoordinator } from '../lib/measured-process.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixtureScript(source) {
  const root = mkdtempSync(join(tmpdir(), 'opensip-mcp-transport-'));
  roots.push(root);
  const script = join(root, 'server.mjs');
  writeFileSync(script, source);
  return { root, script };
}

function jsonCodecs() {
  return {
    deserializeMessage: (line) => JSON.parse(line),
    serializeMessage: (message) => `${JSON.stringify(message)}\n`,
  };
}

function waitFor(register, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('test observation timed out')), timeoutMs);
    register((value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

test('bounded stdio transport counts exact protocol stdout and exposes terminal state', async () => {
  const line = `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`;
  const fixture = fixtureScript(`
    process.stdout.write(${JSON.stringify(line)});
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
  `);
  const transport = new BoundedStdioClientTransport({
    args: [fixture.script],
    command: process.execPath,
    cwd: fixture.root,
    env: { ...process.env },
    maxStderrBytes: 1024,
    maxStdoutBytes: 1024,
    platform: process.platform,
    ...jsonCodecs(),
  });
  const messagePromise = waitFor((resolve) => {
    Object.assign(transport, { onmessage: resolve });
  });
  await transport.start();
  assert.deepEqual(await messagePromise, {
    jsonrpc: '2.0',
    id: 1,
    result: { ok: true },
  });
  await transport.close();

  assert.deepEqual(transport.stdoutSummary(), {
    bytes: Buffer.byteLength(line),
    truncated: false,
  });
  assert.deepEqual(transport.terminalStatus(), { exitCode: 0, signal: null });
  assert.equal(transport.residualDescendants(), 0);
});

test('bounded stdio transport terminates and records overflow before parsing an unbounded line', async () => {
  const fixture = fixtureScript(`
    process.stdout.write('x'.repeat(4096));
    setInterval(() => {}, 1000);
  `);
  const transport = new BoundedStdioClientTransport({
    args: [fixture.script],
    command: process.execPath,
    cwd: fixture.root,
    env: { ...process.env },
    maxStderrBytes: 1024,
    maxStdoutBytes: 32,
    platform: process.platform,
    ...jsonCodecs(),
  });
  const errorPromise = waitFor((resolve) => {
    Object.assign(transport, { onerror: resolve });
  });
  await transport.start();
  const error = await errorPromise;
  assert.match(error.message, /stdout exceeded its byte bound/u);
  await transport.close();

  const stdout = transport.stdoutSummary();
  assert.ok(stdout.bytes > 32);
  assert.equal(stdout.truncated, true);
  assert.notEqual(transport.terminalStatus(), null);
  assert.equal(transport.residualDescendants(), 0);
});

test('bounded stdio transport rejects unterminated trailing protocol bytes on close', async () => {
  const line = `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`;
  const fixture = fixtureScript(`
    process.stdout.write(${JSON.stringify(`${line}unterminated`)});
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
  `);
  const transport = new BoundedStdioClientTransport({
    args: [fixture.script],
    command: process.execPath,
    cwd: fixture.root,
    env: { ...process.env },
    maxStderrBytes: 1024,
    maxStdoutBytes: 1024,
    platform: process.platform,
    ...jsonCodecs(),
  });
  const messagePromise = waitFor((resolve) => {
    Object.assign(transport, { onmessage: resolve });
  });
  const errorPromise = waitFor((resolve) => {
    Object.assign(transport, { onerror: resolve });
  });
  await transport.start();
  await messagePromise;
  await transport.close();

  const error = await errorPromise;
  assert.match(error.message, /unterminated protocol message/u);
  assert.equal(transport.protocolFaulted(), true);
  assert.deepEqual(transport.terminalStatus(), { exitCode: 0, signal: null });
});

test('bounded stdio transport reports a non-closing root as cleanup residue', async () => {
  // eslint-disable-next-line unicorn/prefer-event-target -- child-process test doubles expose EventEmitter seams.
  const child = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- stdio test doubles expose EventEmitter seams.
  child.stdin = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- stdio test doubles expose EventEmitter seams.
  child.stdout = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- stdio test doubles expose EventEmitter seams.
  child.stderr = new EventEmitter();
  child.pid = 83_456;
  child.kill = () => true;
  child.stdin.end = () => {
    /* the synthetic root deliberately never closes */
  };
  child.stdin.write = () => true;

  const transport = new BoundedStdioClientTransport({
    args: [],
    command: 'synthetic-mcp',
    cwd: process.cwd(),
    env: {},
    maxStderrBytes: 1024,
    maxStdoutBytes: 1024,
    platform: 'linux',
    closeGraceMs: 5,
    closeKillMs: 5,
    captureProcessDescendants: async () => [],
    killProcess: () => {
      /* synthetic PID must never reach the host process table */
    },
    readProcessTable: async () => [
      {
        pid: 83_456,
        ppid: 1,
        processGroupId: 83_456,
        sessionToken: '83_456',
        startedAt: 'root',
        command: '/usr/bin/node',
        rssBytes: 1024,
      },
    ],
    spawnChild: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    ...jsonCodecs(),
  });

  await transport.start();
  await transport.close();
  assert.equal(transport.terminalStatus(), null);
  assert.equal(transport.residualDescendants(), 1);
});

test(
  'parent signal waits for bounded TERM-to-KILL cleanup before relaying',
  { skip: process.platform === 'win32' },
  async () => {
    // eslint-disable-next-line unicorn/prefer-event-target -- coordinator test seam uses Node process-style on/off signals.
    const signalSource = new EventEmitter();
    let resolveRelayed;
    const relayed = new Promise((resolve) => {
      resolveRelayed = resolve;
    });
    const coordinator = createParentSignalCoordinator({
      signalSource,
      cleanupTimeoutMs: 3000,
      reraiseSignal: resolveRelayed,
    });
    const fixture = fixtureScript(`
    import { spawn } from 'node:child_process';
    const leaf = spawn(process.execPath, ['-e', ${JSON.stringify(
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);",
    )}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    leaf.stdout.once('data', () => {
      leaf.stdout.destroy();
      leaf.unref();
      process.stdout.write(JSON.stringify({ pid: leaf.pid }) + '\\n');
    });
    setInterval(() => {}, 1000);
  `);
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: { ...process.env },
      maxStderrBytes: 1024,
      maxStdoutBytes: 1024,
      parentSignalCoordinator: coordinator,
      platform: process.platform,
      ...jsonCodecs(),
    });
    const messagePromise = waitFor((resolve) => {
      Object.assign(transport, { onmessage: resolve });
    });
    await transport.start();
    const { pid } = await messagePromise;
    try {
      signalSource.emit('SIGTERM');
      assert.equal(await relayed, 'SIGTERM');
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.throws(() => process.kill(pid, 0));
      assert.equal(transport.residualDescendants(), 0);
    } finally {
      await transport.close();
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already reaped by the bounded connector shutdown.
        }
      }
    }
  },
);

test(
  'inherited stdio escape settles bounded and fails residual accounting closed',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = fixtureScript('');
    const marker = join(fixture.root, 'leaf.pid');
    writeFileSync(
      fixture.script,
      `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      process.stdin.resume();
      process.stdin.once('end', () => {
        const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: ['ignore', 'inherit', 'inherit']
        });
        leaf.unref();
        writeFileSync(${JSON.stringify(marker)}, String(leaf.pid));
        process.exit(0);
      });
    `,
    );
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: { ...process.env },
      maxStderrBytes: 1024,
      maxStdoutBytes: 1024,
      closeGraceMs: 50,
      closeKillMs: 50,
      platform: process.platform,
      ...jsonCodecs(),
    });
    let pid;
    try {
      await transport.start();
      await transport.close();
      pid = Number(readFileSync(marker, 'utf8'));
      assert.deepEqual(transport.terminalStatus(), {
        exitCode: 0,
        signal: null,
      });
      assert.equal(transport.residualDescendants(), 1);
      assert.doesNotThrow(() => process.kill(pid, 0));
    } finally {
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Probe leaf already exited.
          }
        }
      }
    }
  },
);

test('SDK Client runs over the bounded transport and evidence proves both output bounds', async () => {
  const fixture = fixtureScript(`
    import { createInterface } from 'node:readline';
    const lines = createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'bounded-fixture', version: '1.0.0' }
          }
        }) + '\\n');
      } else if (message.method === 'tools/list') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: message.id, result: { tools: [] }
        }) + '\\n');
      }
    });
    lines.on('close', () => process.exit(0));
  `);
  const connector = createDefaultMcpConnector({
    baseEnv: { ...process.env },
    bounds: {
      journeyTimeoutMs: 5000,
      maxStderrBytes: 1024,
      maxStdoutBytes: 4096,
      rssSampleIntervalMs: 25,
    },
    jsEntrypoint: { script: fixture.script },
    platform: process.platform,
    readProcessTable: async () => [],
    repoRoot: REPO_ROOT,
  });

  const client = await connector.connect({ cwd: fixture.root });
  assert.deepEqual(client.serverVersion(), {
    name: 'bounded-fixture',
    version: '1.0.0',
  });
  assert.deepEqual(await client.listTools(), { tools: [] });
  await client.close();

  const [step] = connector.takeStepEvidence();
  assert.equal(step.reasonCode, null);
  assert.equal(step.outputTruncated, false);
  assert.deepEqual(step.diagnostics.includes('mcp-stdout-byte-bound-unavailable'), false);
  assert.ok(step.diagnostics.some((entry) => /^mcp-stdout-bytes:[1-9]\d*$/u.test(entry)));
  assert.ok(step.diagnostics.some((entry) => /^mcp-stderr-bytes:\d+$/u.test(entry)));
});

test('connector RSS sampling includes the startup and initialize window', async () => {
  // eslint-disable-next-line unicorn/prefer-event-target -- child-process test doubles expose EventEmitter seams.
  const child = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- stdio test doubles expose EventEmitter seams.
  child.stdin = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- stdio test doubles expose EventEmitter seams.
  child.stdout = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- stdio test doubles expose EventEmitter seams.
  child.stderr = new EventEmitter();
  child.pid = 84_567;
  child.kill = () => true;
  child.stdin.write = () => true;
  child.stdin.end = () => {
    /* FakeClient.close emits the authoritative close event. */
  };
  let phase = 'startup';

  class FakeClient {
    async connect(transport) {
      await transport.start();
      await new Promise((resolve) => setTimeout(resolve, 40));
      phase = 'steady';
    }

    getServerVersion() {
      return { name: 'startup-rss-fixture', version: '1.0.0' };
    }

    async close() {
      child.emit('close', 0, null);
    }
  }

  const connector = createDefaultMcpConnector({
    baseEnv: {},
    bounds: {
      journeyTimeoutMs: 1000,
      maxStderrBytes: 1024,
      maxStdoutBytes: 1024,
      rssSampleIntervalMs: 5,
    },
    jsEntrypoint: { script: '/synthetic/mcp.js' },
    platform: 'linux',
    repoRoot: REPO_ROOT,
    loadSdk: async () => ({ FakeClient, Client: FakeClient, ...jsonCodecs() }),
    captureProcessDescendants: async () => [],
    killProcess: () => {
      /* synthetic PID must never reach the host process table */
    },
    readProcessTable: async () => [
      {
        pid: 84_567,
        ppid: 1,
        processGroupId: 84_567,
        sessionToken: '84_567',
        startedAt: 'root',
        command: '/usr/bin/node',
        rssBytes: phase === 'startup' ? 50_000 : 500,
      },
    ],
    spawnChild: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });

  const handle = await connector.connect({ cwd: process.cwd() });
  await handle.close();
  assert.deepEqual(connector.rssMeasurement(), {
    status: 'available',
    peakBytes: 50_000,
  });
});
