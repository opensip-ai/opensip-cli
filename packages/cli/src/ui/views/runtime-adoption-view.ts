import { group, line, type Tone, type ViewNode } from '@opensip-cli/cli-ui';
import { formatDuration } from '@opensip-cli/format';

import type { RuntimeAdoptionResult, RuntimeAdoptionStatus } from '@opensip-cli/contracts';

const SUCCESS_STATUSES = new Set<RuntimeAdoptionStatus>([
  'not-found',
  'promoted',
  'already-project',
  'deduplicated',
  'kept-project',
  'cleanup-pending',
]);

interface RuntimeAdoptionPresentation {
  readonly headline: string;
  readonly summary: string;
  readonly symbol: '✓' | '⚠' | '✗';
  readonly tone: Tone;
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
      return adoption.cleanupPending === true
        ? {
            headline: 'Evidence adoption rolled back; cleanup pending',
            summary: 'Normal evidence writes are allowed. Only operation-owned cleanup remains.',
            symbol: '⚠',
            tone: 'warning',
          }
        : {
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
    line([{ text: '  Duration: ', dim: true }, { text: formatDuration(adoption.durationMs) }]),
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

export function isSuccessfulRuntimeAdoption(status: RuntimeAdoptionStatus): boolean {
  return SUCCESS_STATUSES.has(status);
}

export function runtimeAdoptionView(adoption: RuntimeAdoptionResult): ViewNode {
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
