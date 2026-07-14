import assert from 'node:assert/strict';
import test from 'node:test';

import { isDirectInvocation } from '../perf/direct-invocation.mjs';

test('direct invocation recognizes URL-encoded spaces in POSIX entry paths', () => {
  assert.equal(
    isDirectInvocation(
      'file:///workspace/OpenSIP%20CLI/scripts/bench-slo.mjs',
      'scripts/bench-slo.mjs',
      {
        cwd: '/workspace/OpenSIP CLI',
        platform: 'linux',
      },
    ),
    true,
  );
});

test('direct invocation recognizes Windows paths case-insensitively', () => {
  assert.equal(
    isDirectInvocation(
      'file:///C:/Program%20Files/OpenSIP/scripts/build-public-benchmarks-doc.mjs',
      'scripts\\BUILD-PUBLIC-BENCHMARKS-DOC.mjs',
      {
        cwd: 'c:\\program files\\opensip',
        platform: 'win32',
      },
    ),
    true,
  );
});

test('direct invocation rejects missing and different entry paths', () => {
  const moduleUrl = 'file:///workspace/OpenSIP%20CLI/scripts/bench-slo.mjs';
  const runtime = { cwd: '/workspace/OpenSIP CLI', platform: 'darwin' };

  assert.equal(isDirectInvocation(moduleUrl, null, runtime), false);
  assert.equal(isDirectInvocation(moduleUrl, 'scripts/other.mjs', runtime), false);
});
