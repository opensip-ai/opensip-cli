/**
 * init view-model builder — expresses the InitResult's branches
 * (inside-existing-project refusal, ambiguous language, partial-state
 * refusal, re-scaffold/pristine success, creation failure) as a ViewNode.
 */

import { line, group, type Tone, type ViewNode } from '@opensip-cli/cli-ui';

import type {
  AgentGuidanceTargetAction,
  AgentGuidanceTargetResult,
  InitResult,
} from '@opensip-cli/contracts';

function relativize(p: string, cwd: string): string {
  return p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
}

/** Render a pre-formatted multi-line message (verbatim) as one line node per line. */
function verbatim(message: string): ViewNode {
  return group(
    message.split('\n').map((l) => line([{ text: l }])),
    2,
  );
}

function partialStateHeadline(
  state: 'partial-config-only' | 'partial-dir-only' | 'fully-initialized',
  cfg: string,
): string {
  if (state === 'fully-initialized') return 'Already initialized';
  if (state === 'partial-config-only') return `${cfg} present but opensip-cli/ missing`;
  return `opensip-cli/ present but ${cfg} missing`;
}

function createdHeadline(state: InitResult['state']): string {
  if (state === 'fully-initialized') return 'Re-scaffolded';
  if (state === 'partial-config-only' || state === 'partial-dir-only')
    return 'Recovered partial state';
  return 'Scaffolded';
}

function preExistingSummary(fileCount: number): string {
  return `${String(fileCount)} file(s) preserved under opensip-cli/.`;
}

function guidanceActionTone(action: AgentGuidanceTargetAction): Tone | undefined {
  if (action === 'created' || action === 'updated') return 'success';
  if (action === 'skipped') return 'warning';
  return undefined;
}

function guidanceLines(
  targets: readonly AgentGuidanceTargetResult[] | undefined,
  cwd: string,
): ViewNode[] {
  if (targets === undefined || targets.length === 0) return [];
  return targets.map((target) =>
    line([
      { text: `    ${relativize(target.path, cwd)}`, dim: true },
      { text: '  ' },
      { text: target.action, tone: guidanceActionTone(target.action) },
      ...(target.reason === undefined
        ? []
        : [{ text: '  ' }, { text: `(${target.reason})`, dim: true }]),
    ]),
  );
}

function ambiguousView(message: string): ViewNode {
  return group(
    [
      line([
        { text: '✗', tone: 'error' },
        { text: ' ' },
        { text: 'Cannot scaffold — language ambiguous', bold: true },
      ]),
      { kind: 'spacer' },
      line([{ text: `  ${message}` }]),
    ],
    2,
  );
}

function partialStateView(
  err: NonNullable<InitResult['partialStateError']>,
  cwd: string,
  configFilename: string,
): ViewNode {
  const children: ViewNode[] = [
    line([
      { text: '⚠', tone: 'warning' },
      { text: ' ' },
      { text: partialStateHeadline(err.state, configFilename), bold: true },
      { text: ' in ' },
      { text: cwd, dim: true },
    ]),
  ];
  if (err.preExistingFiles.length > 0) {
    children.push(
      { kind: 'spacer' },
      line([
        {
          text: `  Found ${preExistingSummary(err.preExistingFiles.length)}`,
          dim: true,
        },
      ]),
    );
  }
  children.push(
    { kind: 'spacer' },
    line([{ text: '  Choose one:' }]),
    line([
      { text: '    ' },
      { text: 'opensip init --keep', tone: 'brand' },
      { text: '    Re-scaffold examples; preserve custom files.', dim: true },
    ]),
    line([
      { text: '    ' },
      { text: 'opensip init --remove', tone: 'brand' },
      { text: '  Delete opensip-cli/ and scaffold fresh.', dim: true },
    ]),
  );
  return group(children, 2);
}

function createdView(result: InitResult): ViewNode {
  const { cwd } = result;
  const langDisplay =
    result.languages && result.languages.length > 0 ? result.languages.join(', ') : 'unknown';
  const children: ViewNode[] = [
    line([
      { text: '✓', tone: 'success' },
      { text: ` ${createdHeadline(result.state)} for ` },
      { text: langDisplay, bold: true },
      { text: ' in ' },
      { text: cwd, dim: true },
    ]),
  ];
  if (result.createdFiles && result.createdFiles.length > 0) {
    children.push(
      { kind: 'spacer' },
      ...result.createdFiles.map((f) => line([{ text: `    ${relativize(f, cwd)}`, dim: true }])),
    );
  }
  if (result.gitignoreUpdated === true) {
    children.push(line([{ text: '    .gitignore (added opensip-cli/.runtime/)', dim: true }]));
  }
  const guidance = guidanceLines(result.agentGuidance?.targets, cwd);
  if (guidance.length > 0) {
    children.push(line([{ text: '    Agent guidance:', dim: true }]), ...guidance);
  }
  if (result.preExistingFiles && result.preExistingFiles.length > 0) {
    children.push(
      { kind: 'spacer' },
      line([
        {
          text: `  Pre-existing files: ${preExistingSummary(result.preExistingFiles.length)}`,
          dim: true,
        },
      ]),
    );
  }
  children.push(
    { kind: 'spacer' },
    line([{ text: '  Try it:', dim: true }]),
    line([{ text: '    ' }, { text: 'opensip fit --recipe example', tone: 'brand' }]),
    line([{ text: '    ' }, { text: 'opensip sim --recipe example', tone: 'brand' }]),
  );
  return group(children, 2);
}

function refreshView(result: InitResult): ViewNode {
  const children: ViewNode[] = [
    line([
      { text: '✓', tone: 'success' },
      { text: ' Already initialized; refreshed OpenSIP agent guidance in ' },
      { text: result.cwd, dim: true },
    ]),
  ];
  if (result.gitignoreUpdated === true) {
    children.push(line([{ text: '    .gitignore (added opensip-cli/.runtime/)', dim: true }]));
  }
  const guidance = guidanceLines(result.agentGuidance?.targets, result.cwd);
  if (guidance.length > 0) {
    children.push(
      { kind: 'spacer' },
      line([{ text: '  Agent guidance:', dim: true }]),
      ...guidance,
    );
  }
  if (result.state === 'partial-config-only') {
    children.push(
      { kind: 'spacer' },
      line([
        { text: '  Run ' },
        { text: 'opensip init --keep', tone: 'brand' },
        { text: ' to re-scaffold examples.', dim: true },
      ]),
    );
  }
  return group(children, 2);
}

export function viewInit(result: InitResult): ViewNode {
  if (result.insideExistingProject !== undefined)
    return verbatim(result.insideExistingProject.message);
  if (result.ambiguousLanguageError !== undefined)
    return ambiguousView(result.ambiguousLanguageError.message);
  if (result.partialStateError !== undefined)
    return partialStateView(result.partialStateError, result.cwd, result.configFilename);
  if (result.created) return createdView(result);
  if (result.refreshed === true) return refreshView(result);
  return group(
    [
      line([
        { text: '✗', tone: 'error' },
        { text: ` Failed to scaffold ${result.configFilename} at ` },
        { text: result.path, dim: true },
      ]),
    ],
    2,
  );
}
