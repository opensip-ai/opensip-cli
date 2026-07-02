import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  STICKY_COMMENT_MARKER,
  buildCliInvocation,
  deriveActionSummary,
  escapeAnnotationMessage,
  escapeAnnotationProperty,
  evaluateFailure,
  normalizeInputs,
  parseBoolean,
  parseCommandOutcome,
  renderAnnotations,
  renderComment,
  renderSarif,
  tokenizeCommand,
} from './action-lib.mjs';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const baseEnv = {
  INPUT_SUITE: 'audit',
  INPUT_CHANGED: 'true',
  INPUT_ANNOTATIONS: 'true',
  INPUT_SARIF: 'false',
  INPUT_COMMENT: 'false',
  INPUT_FAIL_ON: 'new-errors',
  INPUT_VERSION: 'latest',
  INPUT_WORKING_DIRECTORY: '.',
};

function suiteOutcome(overrides = {}) {
  const brief = {
    version: 1,
    suite: 'audit',
    suiteRunId: 'suite_1',
    verdict: 'fail',
    changedFiles: null,
    topRisks: [
      {
        source: 'fit',
        ruleId: 'fit.no-console-log',
        message: 'Remove console.log',
        severity: 'high',
        file: 'src/index.ts',
        line: 3,
        column: 2,
        isNew: true,
        signalRef: { tool: 'fit', suiteRunId: 'suite_1', stepIndex: 0, signalIndex: 0 },
      },
    ],
    newFindings: [
      {
        source: 'fit',
        ruleId: 'fit.no-console-log',
        message: 'Remove console.log',
        severity: 'high',
        file: 'src/index.ts',
        line: 3,
        column: 2,
        isNew: true,
        signalRef: { tool: 'fit', suiteRunId: 'suite_1', stepIndex: 0, signalIndex: 0 },
      },
    ],
    baselineDelta: { available: true, added: 1, removed: 0, unchanged: 0 },
    degraded: [],
    recommendedActions: [],
    ...overrides.brief,
  };
  return JSON.stringify({
    kind: 'suite-run',
    status: 'ok',
    exitCode: 1,
    data: {
      type: 'suite-run',
      suite: 'audit',
      suiteRunId: 'suite_1',
      exitCode: 1,
      durationMs: 1,
      aggregate: { steps: 3, passed: 2, failed: 1, faulted: 0, errors: 1, warnings: 0 },
      steps: [],
      reviewBrief: brief,
      ...overrides.data,
    },
  });
}

describe('normalizeInputs', () => {
  it('accepts common boolean spellings', () => {
    assert.equal(parseBoolean('YES', 'changed').value, true);
    assert.equal(parseBoolean('0', 'changed').value, false);
    assert.equal(parseBoolean('off', 'changed').value, false);
  });

  it('rejects invalid booleans and fail-on values', () => {
    assert.equal(parseBoolean('maybe', 'changed').ok, false);
    assert.equal(normalizeInputs({ ...baseEnv, INPUT_FAIL_ON: 'sometimes' }).ok, false);
  });

  it('normalizes defaults', () => {
    const normalized = normalizeInputs({});
    assert.equal(normalized.ok, true);
    assert.equal(normalized.value.suite, 'audit');
    assert.equal(normalized.value.changed, true);
    assert.equal(normalized.value.failOn, 'new-errors');
  });
});

describe('buildCliInvocation', () => {
  it('builds the default audit suite invocation', () => {
    const inputs = normalizeInputs(baseEnv).value;
    const invocation = buildCliInvocation(inputs).value;
    assert.deepEqual(invocation, {
      command: 'npx',
      args: ['--yes', 'opensip-cli@latest', 'suite', 'run', 'audit', '--json', '--changed'],
    });
  });

  it('omits changed and appends config when requested', () => {
    const inputs = normalizeInputs({
      ...baseEnv,
      INPUT_CHANGED: 'false',
      INPUT_CONFIG: 'custom.yml',
    }).value;
    const invocation = buildCliInvocation(inputs).value;
    assert.deepEqual(invocation.args.slice(-2), ['--config', 'custom.yml']);
    assert.equal(invocation.args.includes('--changed'), false);
  });

  it('tokenizes command mode and appends json', () => {
    const inputs = normalizeInputs({
      ...baseEnv,
      INPUT_COMMAND: 'opensip fit --check "no console" --changed',
    }).value;
    const invocation = buildCliInvocation(inputs).value;
    assert.deepEqual(invocation.args, [
      '--yes',
      'opensip-cli@latest',
      'fit',
      '--check',
      'no console',
      '--changed',
      '--json',
    ]);
  });

  it('supports a local CLI binary override for validation', () => {
    const inputs = normalizeInputs({ ...baseEnv, OPENSIP_ACTION_CLI_BIN: '/opt/opensip.js' }).value;
    const invocation = buildCliInvocation(inputs).value;
    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[0], '/opt/opensip.js');
  });

  it('rejects unterminated quoted command input', () => {
    assert.equal(tokenizeCommand('fit --check "unterminated').ok, false);
  });
});

describe('outcome parsing and policy', () => {
  it('summarizes a suite outcome', () => {
    const parsed = parseCommandOutcome(suiteOutcome());
    assert.equal(parsed.ok, true);
    const summary = deriveActionSummary(parsed.value);
    assert.equal(summary.verdict, 'fail');
    assert.equal(summary.issues, 1);
    assert.equal(summary.newIssues, 1);
  });

  it('uses the final suite result when child tool JSON precedes it', () => {
    const childToolJson = JSON.stringify({
      kind: 'fit.run',
      status: 'ok',
      exitCode: 1,
      envelope: { tool: 'fit', signals: [] },
    });
    const parsed = parseCommandOutcome(`${childToolJson}\n${suiteOutcome()}`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.kind, 'suite');
  });

  it('does not hide a final structured error behind child tool JSON', () => {
    const childToolJson = JSON.stringify({
      kind: 'fit.run',
      status: 'ok',
      exitCode: 0,
      envelope: { tool: 'fit', signals: [] },
    });
    const errorJson = JSON.stringify({
      status: 'error',
      errors: [{ message: 'suite config failed' }],
    });
    const parsed = parseCommandOutcome(`${childToolJson}\n${errorJson}`);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /suite config failed/u);
  });

  it('fails all-errors on aggregate errors', () => {
    const summary = deriveActionSummary(parseCommandOutcome(suiteOutcome()).value);
    assert.equal(evaluateFailure(summary, 'all-errors').failed, true);
  });

  it('passes new-errors when only unchanged risks remain', () => {
    const parsed = parseCommandOutcome(
      suiteOutcome({
        brief: {
          topRisks: [
            {
              source: 'fit',
              ruleId: 'fit.old',
              message: 'Old finding',
              severity: 'high',
              file: 'src/index.ts',
              isNew: false,
              signalRef: { tool: 'fit', suiteRunId: 'suite_1', stepIndex: 0, signalIndex: 0 },
            },
          ],
          newFindings: [],
          baselineDelta: { available: true, added: 0, removed: 0, unchanged: 1 },
        },
      }),
    );
    const summary = deriveActionSummary(parsed.value);
    assert.equal(evaluateFailure(summary, 'new-errors').failed, false);
  });

  it('falls back to bounded risks for new-errors when baseline is unavailable', () => {
    const parsed = parseCommandOutcome(
      suiteOutcome({
        brief: {
          baselineDelta: { available: false, added: 0, removed: 0, unchanged: 0 },
          newFindings: [],
        },
      }),
    );
    const summary = deriveActionSummary(parsed.value);
    assert.equal(evaluateFailure(summary, 'new-errors').failed, true);
  });

  it('never mode reports without failing', () => {
    const summary = deriveActionSummary(parseCommandOutcome(suiteOutcome()).value);
    assert.equal(evaluateFailure(summary, 'never').failed, false);
  });

  it('surfaces structured CLI error outcomes', () => {
    const parsed = parseCommandOutcome(
      JSON.stringify({ status: 'error', errors: [{ message: 'bad config' }] }),
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /bad config/u);
  });
});

describe('renderers', () => {
  it('escapes workflow command fields and messages', () => {
    assert.equal(escapeAnnotationProperty('a:b,c'), 'a%3Ab%2Cc');
    assert.equal(escapeAnnotationMessage('100%\nno'), '100%25%0Ano');
  });

  it('renders annotations with file and location', () => {
    const summary = deriveActionSummary(parseCommandOutcome(suiteOutcome()).value);
    const annotations = renderAnnotations(summary, 'new-errors');
    assert.match(annotations[0], /^::error /u);
    assert.match(annotations[0], /file=src\/index\.ts/u);
    assert.match(annotations[0], /line=3/u);
    assert.match(annotations[0], /col=3/u);
  });

  it('renders repository-relative paths for absolute findings', () => {
    const summary = deriveActionSummary(parseCommandOutcome(suiteOutcome()).value);
    summary.risks[0].file = '/workspace/project/src/index.ts';
    summary.newRisks[0].file = '/workspace/project/src/index.ts';

    const annotations = renderAnnotations(summary, 'new-errors', '/workspace/project');
    const sarif = JSON.parse(renderSarif(summary, '/workspace/project'));

    assert.match(annotations[0], /file=src\/index\.ts/u);
    assert.doesNotMatch(annotations[0], /workspace\/project/u);
    assert.equal(
      sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
      'src/index.ts',
    );
  });

  it('renders a sticky comment', () => {
    const summary = deriveActionSummary(parseCommandOutcome(suiteOutcome()).value);
    const comment = renderComment(summary);
    assert.match(comment, new RegExp(STICKY_COMMENT_MARKER, 'u'));
    assert.match(comment, /OpenSIP review/u);
    assert.match(comment, /Top risks/u);
  });

  it('renders valid SARIF', () => {
    const summary = deriveActionSummary(parseCommandOutcome(suiteOutcome()).value);
    const sarif = JSON.parse(renderSarif(summary));
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs[0].tool.driver.name, 'opensip-cli github action');
    assert.equal(sarif.runs[0].results[0].ruleId, 'fit.no-console-log');
  });
});

describe('action metadata', () => {
  it('keeps the root action OSS-only', () => {
    const text = readFileSync(join(repoRoot, 'action.yml'), 'utf8');
    assert.match(text, /name: OpenSIP CLI/u);
    assert.match(text, /suite:/u);
    assert.match(text, /fail-on:/u);
    assert.doesNotMatch(text, /api-key:/u);
    assert.doesNotMatch(text, /cloud-url:/u);
  });

  it('keeps Cloud handoff inputs on the nested action', () => {
    const text = readFileSync(join(repoRoot, '.github/actions/upload-sarif/action.yml'), 'utf8');
    assert.match(text, /api-key:/u);
    assert.match(text, /cloud-url:/u);
    assert.match(text, /fail-on-upload-error:/u);
  });
});
