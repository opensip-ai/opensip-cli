/**
 * init view-model builder — expresses the InitResult's branches
 * (inside-existing-project refusal, ambiguous language, partial-state
 * refusal, re-scaffold/pristine success, creation failure) as a ViewNode.
 */

import { line, group, type Tone, type ViewNode } from '@opensip-cli/cli-ui';

import type {
  AgentGuidanceTargetAction,
  AgentGuidanceTargetResult,
  InitOptionalToolRecommendation,
  InitResult,
  RuntimeAdoptionResult,
  RuntimeAdoptionStatus,
} from '@opensip-cli/contracts';

const RUNTIME_ADOPTION_SUCCESSES = new Set<RuntimeAdoptionStatus>([
  'not-found',
  'promoted',
  'already-project',
  'deduplicated',
  'kept-project',
  'cleanup-pending',
]);

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

function optionalToolsFooter(
  recommendations: readonly InitOptionalToolRecommendation[] | undefined,
): ViewNode[] {
  if (recommendations === undefined || recommendations.length === 0) return [];
  const idWidth = Math.max(...recommendations.map((row) => row.id.length));
  return [
    { kind: 'spacer' },
    line([
      {
        text: '  Optional tools for this project (not installed):',
        bold: true,
      },
    ]),
    ...recommendations.map((row) =>
      line([
        { text: '    ' },
        { text: row.id.padEnd(idWidth) },
        { text: '  ' },
        { text: row.installCommand, tone: 'brand' },
        ...(row.network === 'networked'
          ? [{ text: '  [networked]', tone: 'warning' as const }]
          : []),
      ]),
    ),
    { kind: 'spacer' },
    line([
      { text: '  Use ' },
      { text: '--project', tone: 'brand' },
      { text: ' on tools install for repo-local installation.' },
    ]),
    line([{ text: '  Full catalog: ' }, { text: 'opensip tools list --available', tone: 'brand' }]),
  ];
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

function authoredStateChangedView(message: string): ViewNode {
  return group(
    [
      line([
        { text: '⚠', tone: 'warning' },
        { text: ' ' },
        { text: 'Init state changed while planning', bold: true },
      ]),
      { kind: 'spacer' },
      line([{ text: `  ${message}` }]),
    ],
    2,
  );
}

interface RuntimeAdoptionPresentation {
  readonly headline: string;
  readonly summary: string;
  readonly symbol: '✓' | '⚠' | '✗';
  readonly tone: Tone;
}

function runtimeAdoptionPresentation(adoption: RuntimeAdoptionResult): RuntimeAdoptionPresentation {
  switch (adoption.status) {
    case 'not-found': {
      return {
        headline: 'Evidence adoption: no cache evidence found',
        summary: 'Project-authored setup completed without a cache evidence source.',
        symbol: '✓',
        tone: 'success',
      };
    }
    case 'promoted': {
      return {
        headline: 'Evidence adoption: cache evidence promoted',
        summary: 'The selected cache evidence is now project-local authority.',
        symbol: '✓',
        tone: 'success',
      };
    }
    case 'already-project': {
      return {
        headline: 'Evidence adoption: project evidence already active',
        summary: 'The existing project-local evidence remains authoritative.',
        symbol: '✓',
        tone: 'success',
      };
    }
    case 'deduplicated': {
      return {
        headline: 'Evidence adoption: equivalent cache evidence retired',
        summary: 'The equivalent project-local evidence remains authoritative.',
        symbol: '✓',
        tone: 'success',
      };
    }
    case 'kept-project': {
      return {
        headline: 'Evidence adoption: project evidence kept',
        summary: 'The selected project-local evidence remains authoritative.',
        symbol: '✓',
        tone: 'success',
      };
    }
    case 'conflict': {
      return {
        headline: 'Evidence adoption blocked by a conflict',
        summary: conflictSummary(adoption),
        symbol: '⚠',
        tone: 'warning',
      };
    }
    case 'busy': {
      return {
        headline: 'Evidence adoption is busy',
        summary: 'Another OpenSIP operation currently holds the evidence lease.',
        symbol: '⚠',
        tone: 'warning',
      };
    }
    case 'recovery-required': {
      return {
        headline: 'Evidence adoption requires recovery',
        summary: recoveryRequiredSummary(adoption),
        symbol: '✗',
        tone: 'error',
      };
    }
    case 'rolled-back': {
      if (adoption.cleanupPending === true) {
        return {
          headline: 'Evidence adoption rolled back; cleanup pending',
          summary: 'Normal evidence writes are allowed. Only operation-owned cleanup remains.',
          symbol: '⚠',
          tone: 'warning',
        };
      }
      return {
        headline: 'Evidence adoption rolled back',
        summary: 'The attempted evidence adoption did not commit.',
        symbol: '✗',
        tone: 'error',
      };
    }
    case 'cleanup-pending': {
      return {
        headline: 'Evidence adoption committed; cleanup pending',
        summary: 'Normal evidence writes are allowed. Only operation-owned cleanup remains.',
        symbol: '⚠',
        tone: 'warning',
      };
    }
  }
}

function conflictSummary(adoption: RuntimeAdoptionResult): string {
  switch (adoption.reasonCode) {
    case 'weak-source-requires-selection': {
      return 'The cache candidate requires an explicit evidence selection.';
    }
    case 'destination-absent': {
      return 'The requested project evidence authority is not available.';
    }
    case 'divergent': {
      return 'The available evidence candidates require an explicit selection.';
    }
    case 'destination-unverified': {
      return 'OpenSIP could not verify an evidence candidate for automatic selection.';
    }
    case 'state-ambiguous': {
      return 'OpenSIP could not safely select an evidence candidate from the current state.';
    }
    default: {
      return 'OpenSIP could not safely complete evidence selection under the requested policy.';
    }
  }
}

function recoveryRequiredSummary(adoption: RuntimeAdoptionResult): string {
  return adoption.reasonCode === 'operation-interrupted'
    ? 'Retry Init to reconcile the interrupted evidence operation.'
    : 'Retry Init to reconcile the evidence operation safely.';
}

function hasNoCacheSource(adoption: RuntimeAdoptionResult): boolean {
  if (adoption.reasonCode === 'source-absent') return true;
  if (adoption.proofStrength !== undefined || adoption.sourceRetired === true) return false;
  if (adoption.sourcePreserved !== false) return false;
  return (
    (adoption.status === 'cleanup-pending' && adoption.sourceRetired === undefined) ||
    (adoption.status === 'rolled-back' && adoption.sourceRetired === false)
  );
}

function sourceDispositionLabel(adoption: RuntimeAdoptionResult): string {
  if (hasNoCacheSource(adoption)) return 'not applicable (no source)';
  if (adoption.sourcePreserved === undefined) return 'unknown';
  return adoption.sourcePreserved ? 'preserved' : 'not preserved';
}

function runtimeAdoptionDetails(adoption: RuntimeAdoptionResult): ViewNode[] {
  const noCacheSource = hasNoCacheSource(adoption);
  const details: ViewNode[] = [
    line([
      { text: '  Proof strength: ', dim: true },
      { text: adoption.proofStrength ?? 'not available' },
    ]),
    line([
      { text: '  Source disposition: ', dim: true },
      { text: sourceDispositionLabel(adoption) },
    ]),
  ];
  if (!noCacheSource && adoption.sourceRetired !== undefined) {
    details.push(
      line([
        { text: '  Source retired: ', dim: true },
        { text: adoption.sourceRetired ? 'yes' : 'no' },
      ]),
    );
  }
  if (adoption.authored !== undefined) {
    const { created, replaced, deleted, preserved } = adoption.authored;
    details.push(
      line([
        { text: '  Authored state: ', dim: true },
        {
          text: `${created} created · ${replaced} replaced · ${deleted} deleted · ${preserved} preserved`,
        },
      ]),
    );
  }
  details.push(
    line([
      { text: '  Duration: ', dim: true },
      { text: `${Math.max(0, Math.round(adoption.durationMs))} ms` },
    ]),
  );
  if (adoption.reasonCode !== undefined) {
    details.push(line([{ text: '  Reason: ', dim: true }, { text: adoption.reasonCode }]));
  }
  if (adoption.nextCommand !== undefined) {
    details.push(
      line([
        { text: '  Next command: ', dim: true },
        { text: adoption.nextCommand, tone: 'brand' },
      ]),
    );
  }
  return details;
}

function runtimeAdoptionView(adoption: RuntimeAdoptionResult): ViewNode {
  const presentation = runtimeAdoptionPresentation(adoption);
  return group(
    [
      line([
        { text: presentation.symbol, tone: presentation.tone },
        { text: ' ' },
        { text: presentation.headline, bold: true },
      ]),
      { kind: 'spacer' },
      line([{ text: `  ${presentation.summary}` }]),
      ...runtimeAdoptionDetails(adoption),
    ],
    2,
  );
}

function successfulAdoptionView(result: InitResult): ViewNode {
  const adoption = result.runtimeAdoption;
  if (adoption === undefined) return createdView(result);
  let scaffold: ViewNode | undefined;
  if (result.created) scaffold = createdView(result);
  else if (result.refreshed === true) scaffold = refreshView(result);
  return scaffold === undefined
    ? runtimeAdoptionView(adoption)
    : group([scaffold, { kind: 'spacer' }, runtimeAdoptionView(adoption)]);
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
      {
        text: '  Reset Init-authored files; preserve .runtime evidence.',
        dim: true,
      },
    ]),
    line([
      { text: '    ' },
      { text: 'opensip uninstall --project --dry-run', tone: 'brand' },
      { text: '  Preview removal of retained runtime evidence.', dim: true },
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
    ...optionalToolsFooter(result.optionalTools),
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
  if (result.authoredStateChangedError !== undefined)
    return authoredStateChangedView(result.authoredStateChangedError.message);
  if (result.partialStateError !== undefined)
    return partialStateView(result.partialStateError, result.cwd, result.configFilename);
  if (result.runtimeAdoption !== undefined) {
    if (RUNTIME_ADOPTION_SUCCESSES.has(result.runtimeAdoption.status))
      return successfulAdoptionView(result);
    return runtimeAdoptionView(result.runtimeAdoption);
  }
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
