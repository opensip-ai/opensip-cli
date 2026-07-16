/** @fileoverview Shared acceptance diagnostic credential-redaction coverage. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSensitiveKey, redactSensitiveText } from '../platform-acceptance/sensitive-text.mjs';

test('recognizes structural credential-key conventions', () => {
  for (const key of [
    'api_key',
    'apikey',
    'clientSecret',
    'password',
    'private-key',
    'session_key_id',
    'x-amz-signature',
    '_authToken',
  ]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  assert.equal(isSensitiveKey('monkey'), false);
  assert.equal(isSensitiveKey('keynote'), false);
});

test('redacts headers, URL credentials, query values, and plain assignments', () => {
  const input = [
    'https://person:basic-secret@example.test/path?api_key=query-secret&client_secret=client-query-secret',
    'https://token-only-userinfo@example.test/path',
    'Authorization: Bearer header-secret',
    'Bearer standalone-secret',
    // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- deliberate credential-redaction fixture
    'password=plain-secret secret="quoted secret value" _authToken:registry-secret',
    '{"apikey":"json-secret","x-amz-signature":"signed-secret","safe":"visible"}',
    '--token flag-secret --safe visible',
  ].join('\n');
  const redacted = redactSensitiveText(input);

  for (const leaked of [
    'person',
    'basic-secret',
    'token-only-userinfo',
    'query-secret',
    'client-query-secret',
    'header-secret',
    'standalone-secret',
    'plain-secret',
    'quoted secret value',
    'registry-secret',
    'json-secret',
    'signed-secret',
    'flag-secret',
  ]) {
    assert.equal(redacted.includes(leaked), false, leaked);
  }
  assert.match(redacted, /api_key=<redacted>/u);
  assert.match(redacted, /client_secret=<redacted>/u);
  assert.match(redacted, /password=<redacted>/u);
  assert.match(redacted, /"apikey":<redacted>/u);
  assert.match(redacted, /--token <redacted>/u);
  assert.match(redacted, /"safe":"visible"/u);
  assert.match(redacted, /--safe visible/u);
});
