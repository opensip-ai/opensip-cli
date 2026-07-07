/**
 * tools view-model builders — render the ADR-0041 tool-management results
 * without executing any tool runtime code.
 */

import {
  line,
  group,
  viewTable,
  type Span,
  type TableColumnSpec,
  type Tone,
  type ViewNode,
} from '@opensip-cli/cli-ui';

import { renderDiagnosticHuman } from '../render-diagnostic.js';

import type {
  CommandResult,
  ToolsAvailableResult,
  ToolsAvailableRow,
  ToolsCreateResult,
  ToolsDataPurgeResult,
  ToolsDoctorResult,
  ToolsInstallResult,
  ToolsListResult,
  ToolsListRow,
  ToolsUninstallResult,
  ToolsValidateResult,
  ToolsValidateSection,
} from '@opensip-cli/contracts';

const SPACER: ViewNode = { kind: 'spacer' };

const TOOLS_LIST_COLUMNS: readonly (string | TableColumnSpec)[] = [
  'Tool',
  'UUID',
  'Source',
  'Status',
  'Trust',
  'Policy',
  'Version',
  'Package',
  'Commands',
];

const VALIDATION_COLUMNS: readonly (string | TableColumnSpec)[] = ['Section', 'Status', 'Detail'];

const TOOLS_AVAILABLE_COLUMNS: readonly (string | TableColumnSpec)[] = [
  'Adapter',
  'Languages',
  'Network',
  'Installed',
  'Package',
];

function toolsAvailableRow(row: ToolsAvailableRow): Span[] {
  return [
    { text: row.id, tone: 'brand', bold: true },
    { text: row.languages.length === 0 ? 'polyglot' : row.languages.join(', ') },
    { text: row.network, tone: row.network === 'networked' ? 'warning' : 'muted' },
    row.installed
      ? { text: 'installed', tone: 'success' }
      : { text: 'not installed', dim: true },
    { text: row.pkg, dim: true },
  ];
}

function statusTone(status: ToolsValidateSection['status']): Tone {
  switch (status) {
    case 'passed': {
      return 'success';
    }
    case 'failed': {
      return 'error';
    }
    case 'skipped': {
      return 'warning';
    }
  }
}

function verdictTone(verdict: ToolsValidateResult['verdict']): Tone {
  switch (verdict) {
    case 'passed': {
      return 'success';
    }
    case 'failed': {
      return 'error';
    }
    case 'incomplete': {
      return 'warning';
    }
  }
}

function policyOutcomeTone(outcome: ToolsListRow['policyOutcome']): Tone {
  switch (outcome) {
    case 'deny': {
      return 'error';
    }
    case 'allow-with-conditions': {
      return 'warning';
    }
    case 'allow':
    case undefined: {
      return 'muted';
    }
  }
}

function toolsListRow(row: ToolsListRow): Span[] {
  return [
    { text: row.id, tone: 'brand', bold: true },
    { text: row.stableId ?? '-', dim: row.stableId === undefined },
    { text: row.shadowed === true ? `${row.source} (shadowed)` : row.source },
    { text: row.status, tone: row.status === 'loaded' ? 'success' : 'muted' },
    { text: row.trustReason ?? '-', dim: row.trustReason === undefined },
    {
      text: row.policyOutcome ?? '-',
      tone: policyOutcomeTone(row.policyOutcome),
      dim: row.policyOutcome === undefined,
    },
    { text: row.version },
    { text: row.packageName ?? '-', dim: row.packageName === undefined },
    { text: row.commands.length === 0 ? '-' : row.commands.join(', ') },
  ];
}

type ToolsCommandResult = Extract<
  CommandResult,
  {
    type:
      | 'tools-list'
      | 'tools-available'
      | 'tools-doctor'
      | 'tools-create'
      | 'tools-validate'
      | 'tools-install'
      | 'tools-uninstall'
      | 'tools-data-purge';
  }
>;

/** @throws {Error} When the closed tools result union and renderer drift. */
function assertToolsNever(result: never): never {
  throw new Error(`Unhandled tools command result '${JSON.stringify(result)}'`);
}

export function viewToolsResult(result: ToolsCommandResult): ViewNode {
  switch (result.type) {
    case 'tools-list': {
      return viewToolsList(result);
    }
    case 'tools-available': {
      return viewToolsAvailable(result);
    }
    case 'tools-doctor': {
      return viewToolsDoctor(result);
    }
    case 'tools-create': {
      return viewToolsCreate(result);
    }
    case 'tools-validate': {
      return viewToolsValidate(result);
    }
    case 'tools-install': {
      return viewToolsInstall(result);
    }
    case 'tools-uninstall': {
      return viewToolsUninstall(result);
    }
    case 'tools-data-purge': {
      return viewToolsDataPurge(result);
    }
    default: {
      return assertToolsNever(result);
    }
  }
}

function validationSectionRow(section: ToolsValidateSection): Span[] {
  return [
    { text: section.name, tone: 'brand' },
    { text: section.status, tone: statusTone(section.status) },
    {
      text: section.diagnostics.length === 0 ? '-' : section.diagnostics.join('; '),
      dim: section.diagnostics.length === 0,
    },
  ];
}

function validationView(result: ToolsValidateResult, title = 'Tool validation'): ViewNode {
  const children: ViewNode[] = [
    line([
      { text: title, bold: true },
      { text: ` (${result.spec})`, dim: true },
    ]),
    line([
      { text: 'Verdict: ', dim: true },
      {
        text: result.verdict.toUpperCase(),
        tone: verdictTone(result.verdict),
        bold: true,
      },
      ...(result.toolId === undefined
        ? []
        : [
            { text: '  Tool: ', dim: true },
            { text: result.toolId, tone: 'brand' as Tone },
          ]),
    ]),
    SPACER,
    viewTable(VALIDATION_COLUMNS, result.sections.map(validationSectionRow)),
  ];
  return group(children, 2);
}

export function viewToolsCreate(result: ToolsCreateResult): ViewNode {
  if (!result.success) {
    return group(
      [
        line([{ text: '✗', tone: 'error' }, { text: ' Tool scaffold failed' }]),
        line([{ text: result.error ?? 'unknown error', tone: 'error' }]),
      ],
      2,
    );
  }
  const children: ViewNode[] = [
    line([
      { text: '✓', tone: 'success' },
      { text: ' Scaffolded tool ' },
      { text: result.toolId, tone: 'brand', bold: true },
    ]),
    line([{ text: result.dir, dim: true }]),
    ...result.files.map((file) => line([{ text: `  ${file}`, dim: true }])),
  ];
  if (result.nextSteps !== undefined && result.nextSteps.length > 0) {
    children.push(
      SPACER,
      line([{ text: 'Next steps:', bold: true }]),
      ...result.nextSteps.map((step) => line([{ text: `  ${step}`, dim: true }])),
    );
  }
  if (result.hint !== undefined) {
    children.push(SPACER, line([{ text: result.hint, tone: 'warning' }]));
  }
  return group(children, 2);
}

export function viewToolsDoctor(result: ToolsDoctorResult): ViewNode {
  if (result.diagnostics.length === 0) {
    return group(
      [
        line([
          {
            text: 'No bootstrap diagnostics were recorded for this run.',
            dim: true,
          },
        ]),
      ],
      2,
    );
  }
  return group(
    [
      line([
        { text: 'Bootstrap diagnostics', bold: true },
        { text: ` (${result.totalCount})`, dim: true },
      ]),
      SPACER,
      ...result.diagnostics.flatMap((diag) =>
        renderDiagnosticHuman(diag)
          .split('\n')
          .map((text) => line([{ text, tone: diag.severity === 'error' ? 'error' : 'warning' }])),
      ),
    ],
    2,
  );
}

export function viewToolsList(result: ToolsListResult): ViewNode {
  if (result.tools.length === 0) {
    return group([line([{ text: 'No tools found for the selected scope.', dim: true }])], 2);
  }
  return group([
    line([
      { text: 'Tools', bold: true },
      { text: ` (${result.totalCount})`, dim: true },
    ]),
    SPACER,
    group([viewTable(TOOLS_LIST_COLUMNS, result.tools.map(toolsListRow))], 2),
  ]);
}

export function viewToolsAvailable(result: ToolsAvailableResult): ViewNode {
  const scope = result.lang === undefined ? '' : ` · ${result.lang}`;
  if (result.adapters.length === 0) {
    return group(
      [
        line([
          { text: 'No first-party adapters match', dim: true },
          ...(result.lang === undefined ? [] : [{ text: ` language "${result.lang}"`, dim: true }]),
          { text: '.', dim: true },
        ]),
      ],
      2,
    );
  }
  return group([
    line([
      { text: 'Available external-tool adapters', bold: true },
      { text: ` (${result.totalCount}${scope})`, dim: true },
    ]),
    SPACER,
    group([viewTable(TOOLS_AVAILABLE_COLUMNS, result.adapters.map(toolsAvailableRow))], 2),
    SPACER,
    line([
      { text: 'Install with: ', dim: true },
      { text: 'opensip tools install <package>', tone: 'brand' },
    ]),
  ]);
}

export function viewToolsValidate(result: ToolsValidateResult): ViewNode {
  return validationView(result);
}

export function viewToolsInstall(result: ToolsInstallResult): ViewNode {
  const children: ViewNode[] = [
    line([
      {
        text: result.success ? '✓' : '✗',
        tone: result.success ? 'success' : 'error',
      },
      { text: result.success ? ' Installed ' : ' Failed to install ' },
      {
        text: result.toolId ?? result.spec,
        tone: result.success ? 'brand' : 'default',
      },
      { text: ` (${result.scope})`, dim: true },
      ...(result.version === undefined ? [] : [{ text: ` ${result.version}`, dim: true }]),
    ]),
  ];
  if (result.error !== undefined) {
    children.push(line([{ text: `  ${result.error}`, tone: 'error' }]));
  }
  // Single source: the host renders `nextSteps` from the result (the same data
  // `--json` consumers read). Managed install trust is recorded during install,
  // so these steps focus on the first command to try.
  if (result.success && result.nextSteps !== undefined && result.nextSteps.length > 0) {
    children.push(
      SPACER,
      line([{ text: 'Next steps:', bold: true }]),
      ...result.nextSteps.map((step) => line([{ text: `  ${step}`, dim: true }])),
    );
  }
  children.push(SPACER, validationView(result.validation, 'Validation'));
  return group(children, 2);
}

export function viewToolsUninstall(result: ToolsUninstallResult): ViewNode {
  if (!result.success) {
    const spans: Span[] = [
      { text: '✗', tone: 'error' },
      { text: ` Failed to uninstall ${result.target}` },
    ];
    if (result.error !== undefined) spans.push({ text: ` (${result.error})`, dim: true });
    return group([line(spans)], 2);
  }
  const removed = result.removed;
  return group(
    [
      line([
        { text: '✓', tone: 'success' },
        { text: ' Removed ' },
        { text: removed?.id ?? result.target, tone: 'brand' },
        ...(removed === undefined
          ? []
          : [
              {
                text: ` (${removed.packageName}, ${removed.scope})`,
                dim: true,
              },
            ]),
      ]),
    ],
    2,
  );
}

export function viewToolsDataPurge(result: ToolsDataPurgeResult): ViewNode {
  return group(
    [
      line([
        { text: '✓', tone: 'success' },
        { text: ' Purged data for ' },
        { text: result.toolId, tone: 'brand' },
      ]),
      line([
        { text: `  ${result.sessions} session(s), `, dim: true },
        { text: `${result.baselineEntries} baseline entr(ies), `, dim: true },
        {
          text: `${result.baselineMeta ? 1 : 0} baseline marker(s), `,
          dim: true,
        },
        { text: `${result.stateRows} state row(s)`, dim: true },
      ]),
    ],
    2,
  );
}
