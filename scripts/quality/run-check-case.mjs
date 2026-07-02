import { classifyOutcome } from './metrics.mjs';

export async function runCheckCase({ caseRecord, expectation, checkEntry, runCheckOnFixture }) {
  if (typeof runCheckOnFixture !== 'function') {
    throw new TypeError('runCheckCase requires a runCheckOnFixture dependency.');
  }
  const run = await runCheckOnFixture(checkEntry.check, {
    files: caseRecord.files.map((file) => ({ path: file.path, content: file.content })),
    targetPaths: caseRecord.targetPaths,
  });
  const actual = run.findings.length > 0;
  const outcome = classifyOutcome({ expected: expectation.expectFinding, actual });
  return {
    caseId: caseRecord.id,
    corpus: caseRecord.corpus,
    language: caseRecord.language,
    slug: expectation.slug,
    pack: checkEntry.pack,
    expected: expectation.expectFinding,
    actual,
    outcome,
    findingCount: run.findings.length,
    findings: run.findings.slice(0, 5).map((finding) => summarizeFinding(finding)),
  };
}

function summarizeFinding(finding) {
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    message: finding.message,
    filePath: finding.filePath,
    line: finding.line,
    column: finding.column,
    fingerprint: finding.fingerprint,
  };
}
