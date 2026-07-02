import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { renderComment, renderSarif, renderStepSummary } from '../github-action/action-lib.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('comparison docs include required tools and better-choice guidance', () => {
  const text = read('docs/public/00-start/03-vs-other-tools.md');
  for (const tool of ['ESLint', 'Knip', 'dependency-cruiser', 'Semgrep', 'Fallow']) {
    assert.match(text, new RegExp(tool, 'u'), `${tool} must be covered`);
  }
  assert.match(text, /When Knip is the better choice/u);
  assert.match(text, /When dependency-cruiser is the better choice/u);
  assert.match(text, /When Semgrep is the better choice/u);
  assert.match(text, /When Fallow is the better choice/u);
  assert.doesNotMatch(text, /replaces ESLint/u);
  assert.doesNotMatch(text, /replaces Semgrep/u);
  assert.doesNotMatch(text, /faster than Fallow/u);
  assert.doesNotMatch(text, /drop dependency-cruiser/u);
});

test('CI guide links benchmarks and checked action examples without stale timing bullets', () => {
  const text = read('docs/public/60-guides/03-wire-into-ci.md');
  assert.match(text, /\.\.\/70-reference\/12-public-benchmarks\.md/u);
  assert.match(text, /examples\/opensip-action-comment\.md/u);
  assert.match(text, /examples\/opensip-action-summary\.md/u);
  assert.match(text, /examples\/opensip-action-sarif\.md/u);
  assert.doesNotMatch(text, /`fit` \(default recipe, parallel\).*~8s/u);
  assert.doesNotMatch(text, /`graph` \(cold\).*~15s/u);
});

test('action example docs match the action renderers', () => {
  const summary = exampleSummary();
  assert.equal(
    read('docs/public/60-guides/examples/opensip-action-comment.md'),
    renderComment(summary),
  );
  assert.equal(
    read('docs/public/60-guides/examples/opensip-action-summary.md'),
    renderStepSummary(summary),
  );
  assert.deepEqual(
    JSON.parse(read('docs/public/60-guides/examples/opensip-action-sarif.json')),
    JSON.parse(renderSarif(summary)),
  );
  const sarifMarkdown = read('docs/public/60-guides/examples/opensip-action-sarif.md');
  assert.match(sarifMarkdown, /```json/u);
  assert.deepEqual(JSON.parse(extractFence(sarifMarkdown)), JSON.parse(renderSarif(summary)));
});

function read(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

function extractFence(markdown) {
  const match = /```json\n([\S\s]*?)\n```/u.exec(markdown);
  assert.ok(match, 'expected a JSON code fence');
  return match[1];
}

function exampleSummary() {
  return {
    verdict: 'fail',
    issues: 2,
    newIssues: 1,
    degraded: ['baseline-unavailable'],
    risks: [
      {
        source: 'fitness',
        ruleId: 'no-console-log',
        message: 'Console logging should not ship in production code.',
        severity: 'high',
        file: 'src/index.ts',
        line: 3,
        column: 2,
        isNew: true,
        signalRef: { tool: 'fitness', suiteRunId: 'example', stepIndex: 0, signalIndex: 0 },
      },
      {
        source: 'graph',
        ruleId: 'high-blast-untested',
        message: 'Changed function has broad downstream reach without matching tests.',
        severity: 'medium',
        file: 'src/service.ts',
        line: 42,
        column: 0,
        isNew: false,
        signalRef: { tool: 'graph', suiteRunId: 'example', stepIndex: 1, signalIndex: 0 },
      },
    ],
    newRisks: [],
    baselineAvailable: false,
    brief: { baselineDelta: { available: false, added: 1, removed: 0 } },
  };
}
