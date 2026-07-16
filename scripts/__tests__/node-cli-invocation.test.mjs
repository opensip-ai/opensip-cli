import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  ACCEPTANCE_NPM_CLI_ENV,
  NodeCliInvocationError,
  resolveNpmInvocation,
} from '../platform-acceptance/node-cli-invocation.mjs';

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'opensip-npm-invocation-'));
  try {
    const nodeExecPath = join(root, 'node', 'bin', 'node');
    const bundledNpmCli = join(root, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const separateNpmCli = join(root, 'separate npm', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    for (const path of [nodeExecPath, bundledNpmCli, separateNpmCli]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '# fixture');
    }
    return run({
      nodeExecPath,
      bundledNpmCli: realpathSync(bundledNpmCli),
      separateNpmCli: realpathSync(separateNpmCli),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('dedicated acceptance npm seam selects a validated separate-prefix npm CLI', () => {
  withFixture(({ nodeExecPath, separateNpmCli }) => {
    assert.deepEqual(
      resolveNpmInvocation({
        nodeExecPath,
        env: { [ACCEPTANCE_NPM_CLI_ENV]: separateNpmCli },
      }),
      { command: nodeExecPath, prefixArgs: [separateNpmCli] },
    );
  });
});

test('explicit npmCliPath takes precedence over the acceptance environment seam', () => {
  withFixture(({ nodeExecPath, bundledNpmCli, separateNpmCli }) => {
    assert.deepEqual(
      resolveNpmInvocation({
        nodeExecPath,
        npmCliPath: bundledNpmCli,
        env: { [ACCEPTANCE_NPM_CLI_ENV]: separateNpmCli },
      }),
      { command: nodeExecPath, prefixArgs: [bundledNpmCli] },
    );
  });
});

test('an invalid configured acceptance npm seam fails closed instead of falling back', () => {
  withFixture(({ nodeExecPath }) => {
    assert.throws(
      () =>
        resolveNpmInvocation({
          nodeExecPath,
          env: { [ACCEPTANCE_NPM_CLI_ENV]: join(tmpdir(), 'missing', 'npm-cli.js') },
        }),
      NodeCliInvocationError,
    );
  });
});
