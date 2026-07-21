/**
 * Unit coverage for the OIDC publish-readiness classifier — the pure decision
 * that turns a resolved registry probe into new / no-provenance / ok. No
 * network; the probe result is injected.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyPublishReadiness } from '../verify-oidc-publish-readiness.mjs';

test('an absent name is NEW (needs bootstrap + trusted-publisher ceremony)', () => {
  const r = classifyPublishReadiness('@opensip-cli/brand-new', null);
  assert.equal(r.status, 'new');
  assert.match(r.detail, /bootstrap/);
});

test('highest version without an attestation is NO-PROVENANCE (the shared-analysis class)', () => {
  const r = classifyPublishReadiness('@opensip-cli/shared-analysis', {
    highestVersion: '0.8.1',
    highestVersionAttested: false,
  });
  assert.equal(r.status, 'no-provenance');
  assert.equal(r.highestVersion, '0.8.1');
  assert.match(r.detail, /trusted publisher/);
});

test('highest version WITH an attestation is OK (OIDC-published), even if latest tag is older', () => {
  // codebase: highest version 0.8.2 is attested though its `latest` tag is 0.7.0.
  const r = classifyPublishReadiness('@opensip-cli/codebase', {
    highestVersion: '0.8.2',
    highestVersionAttested: true,
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.highestVersion, '0.8.2');
});
