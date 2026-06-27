/**
 * init view-model builder — expresses the InitResult's branches
 * (inside-existing-project refusal, ambiguous language, partial-state
 * refusal, re-scaffold/pristine success, creation failure) as a ViewNode.
 */

import { line, group, type Tone, type ViewNode } from '@opensip-cli/cli-ui';

import type { InitResult, PreExistingFile } from '@opensip-cli/contracts';

function classificationTone(cls: PreExistingFile['classification']): Tone {
  if (cls === 'custom') return 'success';
  if (cls === 'stale-scaffolded') return 'warning';
  return 'brand';
}

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

function preExistingLines(files: readonly PreExistingFile[], cwd: string): ViewNode[] {
  return files.map((f) =>
    line([
      { text: `    ${relativize(f.path, cwd)}`, dim: true },
      {
        text: `  (${f.classification})`,
        tone: classificationTone(f.classification),
      },
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
          text: `  Found ${err.preExistingFiles.length} file(s) under opensip-cli/:`,
          dim: true,
        },
      ]),
      ...preExistingLines(err.preExistingFiles, cwd),
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
  if (result.agentsMdCreated === true) {
    children.push(line([{ text: '    AGENTS.md (agent playbook)', dim: true }]));
  } else if (result.created) {
    children.push(line([{ text: '    AGENTS.md preserved (already present)', dim: true }]));
  }
  if (result.preExistingFiles && result.preExistingFiles.length > 0) {
    children.push(
      { kind: 'spacer' },
      line([{ text: '  Pre-existing files:', dim: true }]),
      ...preExistingLines(result.preExistingFiles, cwd),
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

export function viewInit(result: InitResult): ViewNode {
  if (result.insideExistingProject !== undefined)
    return verbatim(result.insideExistingProject.message);
  if (result.ambiguousLanguageError !== undefined)
    return ambiguousView(result.ambiguousLanguageError.message);
  if (result.partialStateError !== undefined)
    return partialStateView(result.partialStateError, result.cwd, result.configFilename);
  if (result.created) return createdView(result);
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
