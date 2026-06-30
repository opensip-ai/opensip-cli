import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DECISIONS = join(REPO_ROOT, 'docs/decisions');

const PLAN02_ADRS = [
  'ADR-0068-consumption-side-verification-policy.md',
  'ADR-0069-dependency-hygiene-automation-policy.md',
  'ADR-0070-telemetry-and-outbound-network-posture.md',
  'ADR-0071-credential-handling-policy.md',
  'ADR-0072-i18n-posture.md',
  'ADR-0073-update-notification-policy.md',
];

function read(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

test('Plan 02 ADRs exist and include Fitness check lines', () => {
  for (const file of PLAN02_ADRS) {
    const path = join(DECISIONS, file);
    assert.ok(existsSync(path), `missing ${file}`);
    const content = readFileSync(path, 'utf8');
    assert.match(content, /Fitness check:/, `${file} must include Fitness check line`);
  }
});

test('public docs state core enterprise posture without overclaiming enforcement', () => {
  const faq = read('docs/public/00-start/04-faq.md');
  const supplyChain = read('docs/public/70-reference/08-supply-chain-security.md');
  const config = read('docs/public/70-reference/03-configuration.md');
  const env = read('docs/public/70-reference/10-environment-variables.md');

  assert.match(faq, /OpenTelemetry/);
  assert.match(env, /OTEL_EXPORTER_OTLP_ENDPOINT/);
  assert.match(faq, /OPENSIP_NO_UPDATE/);
  assert.match(config, /ADR-0071|not allowed|Not allowed/i);
  assert.match(supplyChain, /Consumption-side verification/i);
  assert.doesNotMatch(
    supplyChain,
    /consumption-side verification is enforced/i,
    'must not claim active consumption enforcement',
  );
});

test('dependency hygiene process doc exists when dependabot is configured', () => {
  const dependabot = existsSync(join(REPO_ROOT, '.github/dependabot.yml'));
  if (dependabot) {
    const dependabotConfig = read('.github/dependabot.yml');
    const supplyChain = read('docs/public/70-reference/08-supply-chain-security.md');
    const adr = read('docs/decisions/ADR-0069-dependency-hygiene-automation-policy.md');

    assert.match(dependabotConfig, /interval:\s*weekly/i);
    assert.match(supplyChain, /Dependabot/i);
    assert.match(supplyChain, /weekly cadence/i);
    assert.match(adr, /Dependabot/i);
  }
});
