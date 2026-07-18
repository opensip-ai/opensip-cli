import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCliTarget, cleanupCliTarget } from '../runner/spawn.js';

import {
  BoundedStdioClientTransport,
  cumulativeMcpStdoutByteLimit,
  defaultConnectionFactory,
  mcpRawFrameByteLimit,
} from './opensip-mcp-connection.js';

const temporaryRoots: string[] = [];

function fixtureScript(source: string): {
  readonly root: string;
  readonly script: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-mcp-transport-'));
  temporaryRoots.push(root);
  const script = join(root, 'server.mjs');
  writeFileSync(script, source, 'utf8');
  return { root, script };
}

function waitFor<T>(register: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise((resolveValue, rejectValue) => {
    const timeout = setTimeout(() => rejectValue(new Error('test observation timed out')), 5000);
    register((value) => {
      clearTimeout(timeout);
      resolveValue(value);
    });
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

/** Wait for process-table reaping after SIGKILL (not instantaneous on loaded CI). */
async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${String(pid)} still alive after ${String(timeoutMs)} ms`);
}

function forceKillProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The test process may already be gone.
    }
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('BoundedStdioClientTransport', () => {
  it('fails closed on Windows where the harness has no Job Object containment', async () => {
    const fixture = fixtureScript('setInterval(() => {}, 1000);');
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: {},
      maxStdoutBytes: 1024,
      platform: 'win32',
    });

    await expect(transport.start()).rejects.toThrow(/Job Object/u);
    await expect(transport.close()).resolves.toBeUndefined();
    expect(transport.pid).toBeUndefined();
  });

  it('uses a shell-free spawn and decodes a fragmented bounded protocol frame', async () => {
    const line = `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`;
    const fixture = fixtureScript(`
      const line = ${JSON.stringify(line)};
      process.stdout.write(line.slice(0, 7));
      setTimeout(() => process.stdout.write(line.slice(7)), 10);
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `);
    let spawnOptions: SpawnOptions | undefined = undefined;
    const spawnChild = ((command: string, args: readonly string[], options: SpawnOptions) => {
      spawnOptions = options;
      return spawn(command, args, options);
    }) as unknown as typeof spawn;
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: {},
      maxStdoutBytes: 1024,
      spawnChild,
    });
    const message = waitFor<unknown>((resolveMessage) => {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
      transport.onmessage = resolveMessage;
    });

    await transport.start();
    await expect(message).resolves.toMatchObject({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
    await expect(transport.close()).resolves.toBeUndefined();

    expect(spawnOptions).toMatchObject({
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(transport.stdoutSummary()).toEqual({
      bytes: Buffer.byteLength(line),
      truncated: false,
    });
    expect(transport.terminalStatus()).toEqual({ exitCode: 0, signal: null });
    expect(transport.protocolError()).toBeUndefined();
  });

  it('terminates when individually valid frames exceed the cumulative session ceiling', async () => {
    const line = `${JSON.stringify({ jsonrpc: '2.0', method: 'progress', params: { value: 'x'.repeat(80) } })}\n`;
    const fixture = fixtureScript(`
      for (let index = 0; index < 20; index += 1) process.stdout.write(${JSON.stringify(line)});
      setInterval(() => {}, 1000);
    `);
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: {},
      maxFrameBytes: 256,
      maxStdoutBytes: 512,
    });
    const error = waitFor<Error>((resolveError) => {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
      transport.onerror = resolveError;
    });

    await transport.start();
    const observedError = await error;
    expect(observedError.message).toMatch(/stdout exceeded its raw byte ceiling/u);
    await expect(transport.close()).rejects.toThrow(/stdout exceeded its raw byte ceiling/u);

    expect(transport.stdoutSummary().bytes).toBeGreaterThan(512);
    expect(transport.stdoutSummary().truncated).toBe(true);
    expect(transport.protocolError()?.message).toMatch(/raw byte ceiling/u);
    expect(transport.terminalStatus()).toBeDefined();
  });

  it('terminates an oversized single frame before it can consume the cumulative budget', async () => {
    const fixture = fixtureScript(`
      process.stdout.write('x'.repeat(4096));
      setInterval(() => {}, 1000);
    `);
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: {},
      maxFrameBytes: 64,
      maxStdoutBytes: 8192,
    });
    const error = waitFor<Error>((resolveError) => {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
      transport.onerror = resolveError;
    });

    await transport.start();
    const observedError = await error;
    expect(observedError.message).toMatch(/frame exceeded its raw byte ceiling/u);
    await expect(transport.close()).rejects.toThrow(/frame exceeded its raw byte ceiling/u);

    expect(transport.stdoutSummary().bytes).toBeLessThanOrEqual(8192);
    expect(transport.protocolError()?.message).toMatch(/frame exceeded/u);
  });

  it('allows multiple individually bounded responses within the cumulative request budget', async () => {
    const responseLines = Array.from({ length: 5 }, (_, index) =>
      JSON.stringify({
        id: index + 1,
        jsonrpc: '2.0',
        result: { value: 'x'.repeat(2048) },
      }),
    );
    const fixture = fixtureScript(`
      for (const line of ${JSON.stringify(responseLines)}) process.stdout.write(line + '\\n');
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `);
    const maxStdoutBytes = cumulativeMcpStdoutByteLimit(4096, 5);
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: {},
      maxFrameBytes: mcpRawFrameByteLimit(4096),
      maxStdoutBytes,
    });
    const messages: unknown[] = [];
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
    transport.onmessage = (message) => messages.push(message);

    await transport.start();
    await waitFor<void>((resolveDone) => {
      const observe = (): void => {
        if (messages.length === responseLines.length) resolveDone();
        else setTimeout(observe, 5);
      };
      observe();
    });
    await transport.close();

    expect(messages).toHaveLength(5);
    expect(transport.stdoutSummary()).toEqual({
      bytes: responseLines.reduce((total, line) => total + Buffer.byteLength(`${line}\n`), 0),
      truncated: false,
    });
  });

  it('allows worst-case JSON unicode escaping within the decoded response budget', async () => {
    const decodedValue = '\u0001'.repeat(20_000);
    const line = `${JSON.stringify({ id: 1, jsonrpc: '2.0', result: { value: decodedValue } })}\n`;
    const maxResponseBytes = Buffer.byteLength(decodedValue);
    expect(Buffer.byteLength(line)).toBeGreaterThan(maxResponseBytes + 64 * 1024);
    expect(Buffer.byteLength(line)).toBeLessThan(mcpRawFrameByteLimit(maxResponseBytes));
    const fixture = fixtureScript(`
      process.stdout.write(${JSON.stringify(line)});
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `);
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: {},
      maxFrameBytes: mcpRawFrameByteLimit(maxResponseBytes),
      maxStdoutBytes: cumulativeMcpStdoutByteLimit(maxResponseBytes, 1),
    });
    const message = waitFor<unknown>((resolveMessage) => {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
      transport.onmessage = resolveMessage;
    });

    await transport.start();
    await expect(message).resolves.toMatchObject({
      result: { value: decodedValue },
    });
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'finishes TERM-to-KILL cleanup when the MCP root exits before its descendant',
    async () => {
      const fixture = fixtureScript('');
      const pidPath = join(fixture.root, 'descendant.pid');
      writeFileSync(
        fixture.script,
        `
          import { spawn } from 'node:child_process';
          import { writeFileSync } from 'node:fs';
          const source = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
          const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });
          writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
          child.unref();
          // Stay alive long enough for process-tree sampling to observe the
          // descendant before the root exits (otherwise cleanup never sees it).
          setTimeout(() => process.exit(0), 450);
        `,
        'utf8',
      );
      const transport = new BoundedStdioClientTransport({
        args: [fixture.script],
        command: process.execPath,
        cwd: fixture.root,
        env: {},
        maxStdoutBytes: 1024,
      });

      await transport.start();
      // Let the fixture spawn + register the descendant before we escalate close.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(transport.close()).resolves.toBeUndefined();
      const descendantPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);

      // Root may exit 0 on its own timer or via close escalation.
      expect(transport.terminalStatus()?.exitCode).toBe(0);
      // close() arms TERM→KILL cleanup; reaping is asynchronous on loaded Linux CI.
      await waitUntilDead(descendantPid, 10_000);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills an observed detached descendant that keeps MCP stdout open',
    async () => {
      const fixture = fixtureScript('');
      const pidPath = join(fixture.root, 'detached-descendant.pid');
      writeFileSync(
        fixture.script,
        `
          import { spawn } from 'node:child_process';
          import { writeFileSync } from 'node:fs';
          const source = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
          const child = spawn(process.execPath, ['-e', source], {
            detached: true,
            stdio: ['ignore', 'inherit', 'ignore']
          });
          writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
          child.unref();
          setTimeout(() => process.exit(0), 450);
        `,
        'utf8',
      );
      const transport = new BoundedStdioClientTransport({
        args: [fixture.script],
        command: process.execPath,
        cwd: fixture.root,
        env: {},
        maxStdoutBytes: 1024,
      });

      await transport.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(transport.close()).resolves.toBeUndefined();
      const descendantPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);

      await waitUntilDead(descendantPid, 10_000);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'force-settles inherited stdio when a detached descendant escapes observation',
    async () => {
      const fixture = fixtureScript('');
      const pidPath = join(fixture.root, 'escaped-descendant.pid');
      writeFileSync(
        fixture.script,
        `
          import { spawn } from 'node:child_process';
          import { writeFileSync } from 'node:fs';
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: true,
            stdio: ['ignore', 'inherit', 'ignore']
          });
          writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
          child.unref();
        `,
        'utf8',
      );
      const transport = new BoundedStdioClientTransport({
        args: [fixture.script],
        command: process.execPath,
        cwd: fixture.root,
        env: {},
        maxStdoutBytes: 1024,
        processSnapshot: () => [],
      });
      const startedAt = performance.now();
      let descendantPid: number | undefined;

      try {
        await transport.start();
        await expect(transport.close()).rejects.toThrow(
          /descendant tracking became unavailable|inherited stdio did not close/u,
        );
        descendantPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
        expect(performance.now() - startedAt).toBeLessThan(5000);
        expect(processIsAlive(descendantPid)).toBe(true);
      } finally {
        if (descendantPid === undefined) {
          try {
            descendantPid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);
          } catch {
            // The fixture may have failed before spawning its descendant.
          }
        }
        if (descendantPid !== undefined) forceKillProcessGroup(descendantPid);
      }
    },
  );

  it('rejects an unterminated trailing frame instead of treating EOF as success', async () => {
    const fixture = fixtureScript(`
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    `);
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: {},
      maxStdoutBytes: 1024,
    });
    const error = waitFor<Error>((resolveError) => {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
      transport.onerror = resolveError;
    });

    await transport.start();
    const observedError = await error;
    expect(observedError.message).toMatch(/unterminated protocol frame/u);
    await expect(transport.close()).rejects.toThrow(/unterminated protocol frame/u);

    expect(transport.protocolError()?.message).toMatch(/unterminated protocol frame/u);
    expect(transport.terminalStatus()).toEqual({ exitCode: 0, signal: null });
  });

  it('surfaces a protocol fault emitted after an otherwise valid response', async () => {
    const validLine = `${JSON.stringify({ id: 1, jsonrpc: '2.0', result: {} })}\n`;
    const fixture = fixtureScript(`
      process.stdout.write(${JSON.stringify(validLine)});
      process.stdout.write('x'.repeat(4096));
      setInterval(() => {}, 1000);
    `);
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: {},
      maxFrameBytes: 64,
      maxStdoutBytes: 8192,
    });
    const message = waitFor<unknown>((resolveMessage) => {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
      transport.onmessage = resolveMessage;
    });

    await transport.start();
    await expect(message).resolves.toMatchObject({ id: 1, result: {} });
    await expect(transport.close()).rejects.toThrow(/frame exceeded its raw byte ceiling/u);
  });

  it('surfaces an abnormal terminal after an otherwise valid response', async () => {
    const validLine = `${JSON.stringify({ id: 1, jsonrpc: '2.0', result: {} })}\n`;
    const fixture = fixtureScript(`
      process.stdout.write(${JSON.stringify(validLine)});
      setTimeout(() => process.exit(23), 10);
    `);
    const transport = new BoundedStdioClientTransport({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: {},
      maxStdoutBytes: 1024,
    });
    const message = waitFor<unknown>((resolveMessage) => {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
      transport.onmessage = resolveMessage;
    });
    const error = waitFor<Error>((resolveError) => {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes callback properties, not EventTarget.
      transport.onerror = resolveError;
    });

    await transport.start();
    await expect(message).resolves.toMatchObject({ id: 1, result: {} });
    const observedError = await error;
    expect(observedError.message).toMatch(/exit 23/u);
    await expect(transport.close()).rejects.toThrow(/exit 23/u);
  });

  it('preserves the McpConnection seam over the SDK public transport contract', async () => {
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
    const connection = defaultConnectionFactory({
      args: [fixture.script],
      command: process.execPath,
      cwd: fixture.root,
      env: {},
    });

    await connection.connect(5000);
    expect(connection.serverVersion()).toEqual({
      name: 'bounded-fixture',
      version: '1.0.0',
    });
    await expect(connection.listTools(5000)).resolves.toEqual({ tools: [] });
    await connection.close();
  });

  it('starts MCP from the verified installed snapshot after the source path is mutated', async () => {
    const fixture = fixtureScript('');
    const packageRoot = join(fixture.root, 'node_modules', 'opensip-cli');
    const entrypoint = join(packageRoot, 'dist', 'server.mjs');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({ bin: { opensip: './dist/server.mjs' }, name: 'opensip-cli', type: 'module' })}\n`,
    );
    writeFileSync(
      entrypoint,
      `
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
                serverInfo: { name: 'verified-snapshot', version: '1.0.0' }
              }
            }) + '\\n');
          }
        });
        lines.on('close', () => process.exit(0));
      `,
      'utf8',
    );
    const target = buildCliTarget(entrypoint);
    writeFileSync(entrypoint, 'process.exit(91);\n', 'utf8');
    const connection = defaultConnectionFactory({
      args: [
        ...target.executionPrelude,
        target.source === 'installed' ? target.executionEntrypoint : target.entrypoint,
      ],
      command: target.command,
      cwd: fixture.root,
      env: {},
    });

    try {
      await connection.connect(5000);
      expect(connection.serverVersion()).toEqual({
        name: 'verified-snapshot',
        version: '1.0.0',
      });
      await connection.close();
    } finally {
      cleanupCliTarget(target);
    }
  });
});
