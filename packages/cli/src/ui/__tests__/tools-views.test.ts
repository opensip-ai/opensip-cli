/**
 * tools view-model builders (ADR-0041). Pure result→ViewNode functions: every
 * branch (empty/populated lists, shadow-marking, each validation status &
 * verdict tone, install/uninstall success & failure shapes) is driven by input
 * variety and asserted through the shared `renderToText` flattener. Previously
 * these only ran under the subprocess command surface (coverage-invisible).
 */

import { renderToText } from '@opensip-cli/cli-ui';
import { describe, expect, it } from 'vitest';

import {
  viewToolsDataPurge,
  viewToolsInstall,
  viewToolsList,
  viewToolsUninstall,
  viewToolsValidate,
} from '../views/tools-views.js';

import type {
  ToolsInstallResult,
  ToolsListResult,
  ToolsListRow,
  ToolsUninstallResult,
  ToolsValidateResult,
} from '@opensip-cli/contracts';

function row(over: Partial<ToolsListRow> = {}): ToolsListRow {
  return {
    id: 'demo-tool',
    version: '1.2.3',
    source: 'bundled',
    commands: ['demo-cmd'],
    status: 'loaded',
    ...over,
  };
}

function validation(over: Partial<ToolsValidateResult> = {}): ToolsValidateResult {
  return {
    type: 'tools-validate',
    spec: '@scope/demo-tool',
    verdict: 'passed',
    sections: [
      { name: 'manifest', status: 'passed', diagnostics: [] },
      { name: 'storage', status: 'failed', diagnostics: ['raw DDL detected'] },
      { name: 'imports', status: 'skipped', diagnostics: [] },
    ],
    ...over,
  };
}

describe('viewToolsList', () => {
  it('renders the empty state when no tools match the scope', () => {
    const result: ToolsListResult = { type: 'tools-list', tools: [], totalCount: 0 };
    expect(renderToText(viewToolsList(result))).toMatch(/No tools found/);
  });

  it('renders a table with count, shadow-marking, and missing-package dash', () => {
    const result: ToolsListResult = {
      type: 'tools-list',
      tools: [
        row({ id: 'fitness', packageName: undefined }),
        row({
          id: 'shadow-tool',
          source: 'global',
          shadowed: true,
          status: 'manifest-only',
          packageName: '@x/shadow',
          commands: [],
        }),
      ],
      totalCount: 2,
    };
    const out = renderToText(viewToolsList(result));
    expect(out).toContain('Tools');
    expect(out).toContain('(2)');
    expect(out).toContain('fitness');
    expect(out).toContain('global (shadowed)');
    // commands.length === 0 renders a dash, not an empty cell.
    expect(out).toContain('-');
  });
});

describe('viewToolsValidate', () => {
  it('renders every section status and the verdict (passed)', () => {
    const out = renderToText(viewToolsValidate(validation()));
    expect(out).toContain('Tool validation');
    expect(out).toContain('PASSED');
    expect(out).toContain('manifest');
    expect(out).toContain('raw DDL detected');
  });

  it('renders the failed and incomplete verdict tones', () => {
    expect(renderToText(viewToolsValidate(validation({ verdict: 'failed' })))).toContain('FAILED');
    expect(renderToText(viewToolsValidate(validation({ verdict: 'incomplete' })))).toContain(
      'INCOMPLETE',
    );
  });

  it('includes the tool id when present', () => {
    const out = renderToText(viewToolsValidate(validation({ toolId: 'demo-tool' })));
    expect(out).toContain('demo-tool');
  });
});

describe('viewToolsInstall', () => {
  it('renders a successful install with scope, version, and nested validation', () => {
    const result: ToolsInstallResult = {
      type: 'tools-install',
      spec: '@scope/demo-tool',
      success: true,
      scope: 'global',
      toolId: 'demo-tool',
      version: '1.2.3',
      // The host renders the allowlist breadcrumb from `nextSteps` (the same
      // data `--json` consumers read); `install` always populates it on success.
      nextSteps: ["export OPENSIP_CLI_ALLOW_INSTALLED_TOOLS='demo-tool'", 'opensip demo-tool'],
      validation: validation(),
    };
    const out = renderToText(viewToolsInstall(result));
    expect(out).toContain('Installed');
    expect(out).toContain('demo-tool');
    expect(out).toContain('global');
    expect(out).toContain('Validation');
    expect(out).toContain('Next steps:');
    expect(out).toContain("OPENSIP_CLI_ALLOW_INSTALLED_TOOLS='demo-tool'");
  });

  it('renders a failed install with the error line', () => {
    const result: ToolsInstallResult = {
      type: 'tools-install',
      spec: '@scope/demo-tool',
      success: false,
      scope: 'project',
      validation: validation({ verdict: 'failed' }),
      error: 'activation failed',
    };
    const out = renderToText(viewToolsInstall(result));
    expect(out).toContain('Failed to install');
    expect(out).toContain('activation failed');
  });
});

describe('viewToolsUninstall', () => {
  it('renders a successful removal with the removed package detail', () => {
    const result: ToolsUninstallResult = {
      type: 'tools-uninstall',
      success: true,
      target: 'demo-tool',
      removed: { id: 'demo-tool', packageName: '@scope/demo-tool', scope: 'global' },
    };
    const out = renderToText(viewToolsUninstall(result));
    expect(out).toContain('Removed');
    expect(out).toContain('@scope/demo-tool');
  });

  it('falls back to the target when no removed detail is present', () => {
    const result: ToolsUninstallResult = {
      type: 'tools-uninstall',
      success: true,
      target: 'demo-tool',
    };
    expect(renderToText(viewToolsUninstall(result))).toContain('demo-tool');
  });

  it('renders a failure with the error suffix', () => {
    const result: ToolsUninstallResult = {
      type: 'tools-uninstall',
      success: false,
      target: 'demo-tool',
      error: 'not installed',
    };
    const out = renderToText(viewToolsUninstall(result));
    expect(out).toContain('Failed to uninstall demo-tool');
    expect(out).toContain('not installed');
  });
});

describe('viewToolsDataPurge', () => {
  it('renders the per-tool purge counts', () => {
    const out = renderToText(
      viewToolsDataPurge({
        type: 'tools-data-purge',
        toolId: 'fit',
        sessions: 3,
        baselineEntries: 7,
        baselineMeta: true,
        stateRows: 2,
      }),
    );
    expect(out).toContain('Purged data for');
    expect(out).toContain('fit');
    expect(out).toContain('3 session(s)');
    expect(out).toContain('7 baseline entr(ies)');
    expect(out).toContain('1 baseline marker(s)');
    expect(out).toContain('2 state row(s)');
  });
});
