/** @fileoverview Sanitized auxiliary installed-agent report writer coverage. */

import assert from 'node:assert/strict';
import {
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  AGENT_REPORT_WRITE_REASONS,
  sanitizeInstalledAgentReport,
  writeSanitizedInstalledAgentReport,
} from '../platform-acceptance/agent-report-writer.mjs';

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opensip-agent-report-'));
  roots.push(root);
  const runRoot = join(root, 'run');
  const outRoot = join(root, 'out');
  mkdirSync(runRoot);
  mkdirSync(outRoot);
  return { root, runRoot, outRoot };
}

after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('writes an exclusive bounded artifact with credentials and absolute paths sanitized', () => {
  const { runRoot, outRoot } = fixture();
  const outPath = join(outRoot, 'agent-eval-installed-smoke.json');
  const report = {
    schemaVersion: 1,
    cliVersion: '1.2.3',
    details: {
      cwd: `${runRoot}/journeys/agent`,
      endpoint: 'https://person:secret@example.test/a?token=abc123',
      npm_token: 'top-secret',
      relativePath: 'src/index.ts',
    },
  };
  const written = writeSanitizedInstalledAgentReport({
    report,
    outPath,
    runRoot,
    repoRoot: '/workspace/private-repo',
    maxBytes: 1024 * 1024,
  });

  assert.equal(written.path, outPath);
  assert.equal(statSync(outPath).mode & 0o777, 0o600);
  const raw = readFileSync(outPath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.details.relativePath, 'src/index.ts');
  assert.equal(parsed.details.npm_token, '<redacted>');
  assert.match(parsed.details.cwd, /<path>/);
  for (const leaked of [runRoot, 'person', 'secret', 'abc123', 'top-secret']) {
    assert.ok(!raw.includes(leaked), `artifact leaked ${leaked}`);
  }
});

test('sanitizes private/signing keys, cookies, bearer credentials, PEM blocks, and UNC paths', () => {
  const { runRoot } = fixture();
  const sanitized = sanitizeInstalledAgentReport(
    {
      privateKey: 'private-key-secret',
      signing_key: 'signing-key-secret',
      setCookie: 'session=cookie-secret',
      diagnostics: [
        'Authorization: Bearer bearer-secret',
        'Cookie: session=header-cookie-secret',
        'https://example.test/run?api_key=query-api-secret&client_secret=query-client-secret',
        // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- deliberate credential-redaction fixture
        'api_key=plain-api-secret client_secret: plain-client-secret password=plain-password-secret secret="quoted secret value"',
        '-----BEGIN PRIVATE KEY-----\npem-secret\n-----END PRIVATE KEY-----',
        String.raw`\\server\private\credential.txt`,
        '//server/private/credential.txt',
        'file://server/private/credential.txt',
      ],
    },
    [runRoot],
  );
  const raw = JSON.stringify(sanitized);

  assert.equal(sanitized.privateKey, '<redacted>');
  assert.equal(sanitized.signing_key, '<redacted>');
  assert.equal(sanitized.setCookie, '<redacted>');
  assert.ok(
    sanitized.diagnostics.every((entry) => entry.includes('<redacted>') || entry === '<path>'),
  );
  for (const leaked of [
    'private-key-secret',
    'signing-key-secret',
    'cookie-secret',
    'bearer-secret',
    'query-api-secret',
    'query-client-secret',
    'plain-api-secret',
    'plain-client-secret',
    'plain-password-secret',
    'quoted secret value',
    'pem-secret',
    'server',
    'credential.txt',
  ]) {
    assert.ok(!raw.includes(leaked), `sanitized report leaked ${leaked}`);
  }
});

test('fails closed for run-root, existing/symlink, and oversized destinations', () => {
  const { runRoot, outRoot } = fixture();
  const invoke = (outPath, report, maxBytes = 1024) =>
    writeSanitizedInstalledAgentReport({
      report: report ?? { ok: true },
      outPath,
      runRoot,
      maxBytes,
    });

  assert.throws(
    () => invoke(join(runRoot, 'inside.json')),
    (error) => error.reasonCode === AGENT_REPORT_WRITE_REASONS.OUT_INSIDE_RUN_ROOT,
  );

  const existing = join(outRoot, 'existing.json');
  writeFileSync(existing, '{}\n');
  assert.throws(
    () => invoke(existing),
    (error) => error.reasonCode === AGENT_REPORT_WRITE_REASONS.OUT_EXISTS,
  );

  const target = join(outRoot, 'target.json');
  const linked = join(outRoot, 'linked.json');
  writeFileSync(target, '{}\n');
  symlinkSync(target, linked);
  assert.throws(
    () => invoke(linked),
    (error) => error.reasonCode === AGENT_REPORT_WRITE_REASONS.OUT_IS_SYMLINK,
  );

  assert.throws(
    () => invoke(join(outRoot, 'large.json'), { blob: 'x'.repeat(512) }, 128),
    (error) => error.reasonCode === AGENT_REPORT_WRITE_REASONS.REPORT_TOO_LARGE,
  );
});

test('retries short writeSync results until the complete sanitized report is durable', () => {
  const { runRoot, outRoot } = fixture();
  const outPath = join(outRoot, 'agent-eval-installed-smoke.json');
  let writes = 0;
  const result = writeSanitizedInstalledAgentReport(
    {
      report: { ok: true, values: ['one', 'two', 'three'] },
      outPath,
      runRoot,
      maxBytes: 1024,
    },
    {
      writeSync(descriptor, buffer, offset, length) {
        writes += 1;
        const bytes = Math.min(length, 5);
        return writeSync(descriptor, buffer, offset, bytes);
      },
    },
  );

  assert.ok(writes > 1);
  assert.equal(result.path, outPath);
  assert.deepEqual(JSON.parse(readFileSync(outPath, 'utf8')), {
    ok: true,
    values: ['one', 'two', 'three'],
  });
});

test(
  'fsyncs the parent directory after committing the exclusive hard link',
  { skip: process.platform === 'win32' },
  () => {
    const { runRoot, outRoot } = fixture();
    const outPath = join(outRoot, 'agent-eval-installed-smoke.json');
    let fsyncCalls = 0;

    writeSanitizedInstalledAgentReport(
      { report: { ok: true }, outPath, runRoot, maxBytes: 1024 },
      {
        fsyncSync(descriptor) {
          fsyncCalls += 1;
          return fsyncSync(descriptor);
        },
      },
    );

    assert.equal(fsyncCalls, 2, 'expected one file fsync and one parent-directory fsync');
    assert.ok(existsSync(outPath));
  },
);

test('treats the hard link as committed when private temp cleanup fails', () => {
  const { runRoot, outRoot } = fixture();
  const outPath = join(outRoot, 'agent-eval-installed-smoke.json');

  const result = writeSanitizedInstalledAgentReport(
    { report: { ok: true }, outPath, runRoot, maxBytes: 1024 },
    {
      rmSync(path, options) {
        if (path.endsWith('.tmp')) throw new Error('injected private-temp cleanup failure');
        return rmSync(path, options);
      },
    },
  );

  assert.equal(result.path, outPath);
  assert.deepEqual(JSON.parse(readFileSync(outPath, 'utf8')), { ok: true });
});

test(
  'rolls back the final link when parent-directory durability cannot be confirmed',
  { skip: process.platform === 'win32' },
  () => {
    const { runRoot, outRoot } = fixture();
    const outPath = join(outRoot, 'agent-eval-installed-smoke.json');
    let fsyncCalls = 0;

    assert.throws(
      () =>
        writeSanitizedInstalledAgentReport(
          { report: { ok: true }, outPath, runRoot, maxBytes: 1024 },
          {
            fsyncSync(descriptor) {
              fsyncCalls += 1;
              if (fsyncCalls === 2) throw new Error('injected parent fsync failure');
              return fsyncSync(descriptor);
            },
          },
        ),
      (error) => error.reasonCode === AGENT_REPORT_WRITE_REASONS.WRITE_FAILED,
    );
    assert.equal(fsyncCalls, 2);
    assert.equal(existsSync(outPath), false);
  },
);

test('preserves dangerous JSON keys without prototype mutation or dropped structure', () => {
  const { runRoot, outRoot } = fixture();
  const outPath = join(outRoot, 'agent-eval-installed-smoke.json');
  const report = JSON.parse(`{
    "__proto__": { "polluted": "top-level" },
    "constructor": { "prototype": { "polluted": "constructor" } },
    "prototype": { "__proto__": { "polluted": "nested" } },
    "nested": { "__proto__": { "kept": true }, "constructor": "kept", "prototype": "kept" }
  }`);

  const sanitized = sanitizeInstalledAgentReport(report, [runRoot]);
  assert.equal(Object.getPrototypeOf(sanitized), null);
  assert.equal(Object.getPrototypeOf(sanitized.nested), null);
  assert.ok(Object.hasOwn(sanitized, '__proto__'));
  assert.ok(Object.hasOwn(sanitized, 'constructor'));
  assert.ok(Object.hasOwn(sanitized, 'prototype'));
  assert.ok(Object.hasOwn(sanitized.nested, '__proto__'));
  assert.equal(sanitized.__proto__.polluted, 'top-level');
  assert.equal(sanitized.nested.__proto__.kept, true);
  assert.equal({}.polluted, undefined);

  writeSanitizedInstalledAgentReport({
    report,
    outPath,
    runRoot,
    maxBytes: 1024,
  });

  const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.deepEqual(parsed, report);
  assert.ok(Object.hasOwn(parsed, '__proto__'));
  assert.ok(Object.hasOwn(parsed, 'constructor'));
  assert.ok(Object.hasOwn(parsed, 'prototype'));
  assert.ok(Object.hasOwn(parsed.nested, '__proto__'));
  assert.equal({}.polluted, undefined);
});
