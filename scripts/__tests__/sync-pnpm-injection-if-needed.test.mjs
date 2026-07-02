import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { syncPnpmInjectionIfNeeded } from '../sync-pnpm-injection-if-needed.mjs';

test('syncPnpmInjectionIfNeeded is a no-op when injected content is fresh', () => {
  const calls = [];
  const logs = [];

  const result = syncPnpmInjectionIfNeeded({
    run: (...args) => calls.push(args),
    logger: (message) => logs.push(message),
    verify: () => ({ checked: 2, issuesByPkg: new Map() }),
  });

  assert.deepEqual(result, { checked: 2, synced: false });
  assert.deepEqual(calls, []);
  assert.match(logs.join('\n'), /OK/);
});

test('syncPnpmInjectionIfNeeded removes workspace state and reinstalls when stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-pnpm-injection-'));
  const stateFile = join(root, 'node_modules', '.pnpm-workspace-state-v1.json');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(stateFile, '{}', { flag: 'wx' });

  const calls = [];
  const logs = [];
  let verifyCalls = 0;

  const result = syncPnpmInjectionIfNeeded({
    repoRoot: root,
    run: (...args) => calls.push(args),
    logger: (message) => logs.push(message),
    verify: () => {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        return {
          checked: 1,
          issuesByPkg: new Map([
            ['@opensip-cli/core', [{ kind: 'entry', entry: './dist/index.js' }]],
          ]),
        };
      }
      return { checked: 1, issuesByPkg: new Map() };
    },
  });

  assert.deepEqual(result, { checked: 1, synced: true });
  assert.equal(existsSync(stateFile), false);
  assert.match(logs.join('\n'), /Refreshing injected workspace copies/);
  assert.deepEqual(calls, [
    ['pnpm', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'inherit' }],
  ]);
});
