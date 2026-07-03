import { renderToText } from '@opensip-cli/cli-ui';
import { describe, expect, it } from 'vitest';

import { viewRepair } from '../repair-views.js';

import type {
  RepairApplyResult,
  RepairApplyVerifyResult,
  RepairFileChange,
  RepairPreviewResult,
} from '@opensip-cli/contracts';

function change(overrides: Partial<RepairFileChange> = {}): RepairFileChange {
  return {
    filePath: 'src/a.ts',
    status: 'modified',
    beforeHash: 'before',
    afterHash: 'after',
    diff: 'diff',
    ...overrides,
  };
}

function baseResult(overrides: Partial<RepairApplyResult> = {}): RepairApplyResult {
  return {
    type: 'repair-apply',
    status: 'applied',
    session: { id: 'session_1', tool: 'fit' },
    signal: {
      id: 'sig-1',
      ruleId: 'rule-a',
      message: 'A finding',
      filePath: 'src/a.ts',
      line: 10,
    },
    action: { id: 'fix-a', title: 'Fix A', kind: 'replace-text', autofixable: true },
    changes: [change()],
    ...overrides,
  };
}

function verifyResult(overrides: Partial<RepairApplyVerifyResult> = {}): RepairApplyVerifyResult {
  return {
    ...baseResult(),
    type: 'repair-apply-verify',
    verification: {
      status: 'partial',
      coverage: 'changed-only',
      scope: {
        tool: 'fit',
        ruleId: 'rule-a',
        files: ['src/a.ts'],
        checkRan: false,
        changedImpacted: false,
        fallback: 'unknown',
      },
      commands: [{ tool: 'fit', args: ['fit', '--check', 'rule-a'], cwd: '/repo' }],
      remainingFindings: [
        { id: 'finding-1', ruleId: 'rule-a', message: 'still present', filePath: 'src/a.ts' },
      ],
      failure: { code: 'not-verified', message: 'Verification did not pass.' },
    },
    ...overrides,
  };
}

describe('viewRepair', () => {
  it('renders preview title, missing signal location, and verification guidance commands', () => {
    const preview: RepairPreviewResult = {
      ...baseResult(),
      type: 'repair-preview',
      status: 'previewed',
      signal: { id: 'sig-1', ruleId: 'rule-a', message: 'A finding' },
      verification: { commands: ['opensip fit --check rule-a --changed'] },
    };
    const out = renderToText(viewRepair(preview));

    expect(out).toContain('Repair preview');
    expect(out).toContain('PREVIEWED');
    expect(out).toContain('  -');
    expect(out).toContain('Verify:');
    expect(out).toContain('opensip fit --check rule-a --changed');
  });

  it('renders modified and unchanged repair changes', () => {
    const out = renderToText(
      viewRepair(
        baseResult({
          changes: [
            change({ filePath: 'src/a.ts', status: 'modified' }),
            change({ filePath: 'src/b.ts', status: 'unchanged' }),
          ],
        }),
      ),
    );

    expect(out).toContain('Repair apply');
    expect(out).toContain('APPLIED');
    expect(out).toContain('modified src/a.ts');
    expect(out).toContain('unchanged src/b.ts');
  });

  it('renders refusal and empty-change states', () => {
    expect(
      renderToText(
        viewRepair(
          baseResult({
            status: 'refused',
            changes: [],
            refusal: { code: 'dirty-worktree', message: 'Worktree is dirty.' },
          }),
        ),
      ),
    ).toContain('Worktree is dirty.');

    expect(
      renderToText(viewRepair(baseResult({ status: 'already-applied', changes: [] }))),
    ).toContain('No file changes.');
  });

  it('renders verification scope, remaining findings, failure, and commands', () => {
    const out = renderToText(viewRepair(verifyResult()));

    expect(out).toContain('Repair apply verify');
    expect(out).toContain('Verification:');
    expect(out).toContain('PARTIAL');
    expect(out).toContain('fallback=unknown');
    expect(out).toContain('Remaining matching findings:');
    expect(out).toContain('Verification did not pass.');
    expect(out).toContain('opensip fit --check rule-a');
  });

  it('renders verified and refused apply-verify states with sparse verification details', () => {
    const verified = renderToText(
      viewRepair(
        verifyResult({
          verification: {
            status: 'verified',
            coverage: 'full',
            scope: {
              tool: 'fit',
              ruleId: 'rule-a',
              files: ['src/a.ts'],
              checkRan: true,
              changedImpacted: true,
              fallback: 'targeted',
            },
            commands: [],
            remainingFindings: [],
          },
        }),
      ),
    );
    expect(verified).toContain('VERIFIED');
    expect(verified).toContain('ran');
    expect(verified).not.toContain('Remaining matching findings:');

    const refused = renderToText(
      viewRepair(
        verifyResult({
          status: 'refused',
          refusal: { code: 'manual-only', message: 'Manual only.' },
          changes: [],
          verification: {
            status: 'skipped',
            coverage: 'unknown',
            scope: {
              tool: 'fit',
              ruleId: 'rule-a',
              files: [],
              checkRan: false,
              changedImpacted: false,
              fallback: 'unknown',
            },
            commands: [],
            remainingFindings: [],
          },
        }),
      ),
    );
    expect(refused).toContain('Manual only.');
    expect(refused).toContain('SKIPPED');
  });
});
