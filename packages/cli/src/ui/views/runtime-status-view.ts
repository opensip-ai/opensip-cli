/** Compact, path-free human presentation for `opensip status`. */

import { group, line, type Tone, type ViewNode } from '@opensip-cli/cli-ui';

import { formatBytes } from '../../format-bytes.js';

import type { RuntimeStatusResult } from '@opensip-cli/contracts';

const SPACER: ViewNode = { kind: 'spacer' };
const CLEANUP_PENDING_TEXT =
  'Normal evidence reads and writes may continue, so runtime state can evolve; only operation-owned cleanup is pending.';

function runtimeLocationText(
  location: RuntimeStatusResult['cache'] | RuntimeStatusResult['project'],
  inspectionUnavailable: boolean,
): string {
  if (inspectionUnavailable) return 'inspection unavailable';
  if (!location.exists) return 'not present';
  if (location.sizeBytes === undefined) return 'present · size unavailable';
  const suffix =
    location.sizeTruncated === true ? ' (bounded scan; actual size may be larger)' : '';
  return `present · ${formatBytes(location.sizeBytes)}${suffix}`;
}

function adoptionGuidance(result: RuntimeStatusResult): {
  readonly text: string;
  readonly tone: Tone;
} {
  switch (result.adoptionState) {
    case 'ready': {
      return {
        text: 'Cached evidence is ready to move into this project with opensip init.',
        tone: 'success',
      };
    }
    case 'not-needed': {
      return { text: 'No storage conflict needs attention.', tone: 'success' };
    }
    case 'legacy-unverified': {
      if (
        result.activePlane === 'none' &&
        result.nextCommands.includes('opensip init --runtime-conflict use-cache')
      ) {
        return {
          text: 'A legacy cache candidate matches this project, but it is not the active no-init runtime. Adopt it only with the explicit use-cache command shown below.',
          tone: 'warning',
        };
      }
      if (result.cache.identityStrength === 'path-only') {
        return {
          text: 'Cache identity is path-only: OpenSIP cannot distinguish a repository recreated at the same path, so this evidence will not be adopted automatically.',
          tone: 'warning',
        };
      }
      return {
        text: 'Legacy cache identity is unverified, so this evidence will not be attributed to the project. It will not be adopted automatically.',
        tone: 'warning',
      };
    }
    case 'conflict': {
      const canKeep = result.nextCommands.includes('opensip init --runtime-conflict keep-project');
      const canUseCache = result.nextCommands.includes('opensip init --runtime-conflict use-cache');
      if (!canKeep || !canUseCache) {
        return {
          text: 'OpenSIP found ambiguous, unverified, or unsafe storage state and cannot select an adoption source. No runtime-conflict command is safe to recommend.',
          tone: 'warning',
        };
      }
      return {
        text: 'Cache and project evidence both exist. Choose one explicitly with opensip init; OpenSIP will not merge them.',
        tone: 'warning',
      };
    }
    case 'busy': {
      return {
        text: 'Runtime maintenance is active; retry after the current operation completes.',
        tone: 'warning',
      };
    }
    case 'recovery-required': {
      return {
        text: 'Runtime recovery is required before analysis can continue.',
        tone: 'error',
      };
    }
  }
}

function activePlaneLabel(result: RuntimeStatusResult): string {
  if (result.inspectionUnavailable === true) return 'inspection unavailable';
  if (result.activePlane === 'cache') return 'user cache';
  return result.activePlane;
}

function evidenceDatabaseText(result: RuntimeStatusResult): string {
  if (result.inspectionUnavailable === true) return 'inspection unavailable';
  if (!result.evidenceDatabase.exists) return 'not present';
  if (result.evidenceDatabase.sizeBytes === undefined) return 'present · size unavailable';
  return `present · ${formatBytes(result.evidenceDatabase.sizeBytes)}`;
}

function sourceDispositionText(sourcePreserved: boolean | undefined): string {
  if (sourcePreserved === true) return 'preserved';
  if (sourcePreserved === false) return 'not preserved';
  return 'unknown from bounded status inspection';
}

/** Render the customer-visible status projection without revealing filesystem locations. */
export function viewRuntimeStatus(result: RuntimeStatusResult): ViewNode {
  const activePlane = activePlaneLabel(result);
  const adoption = adoptionGuidance(result);
  const children: ViewNode[] = [
    line([{ text: 'OpenSIP evidence storage', bold: true }]),
    line([
      { text: 'Active: ', dim: true },
      {
        text: activePlane,
        tone: result.activePlane === 'none' ? 'muted' : 'brand',
      },
      ...(result.inspectionUnavailable === true
        ? []
        : [
            {
              text: ` · project ${result.projectInitialized ? 'initialized' : 'not initialized'}`,
              dim: true,
            } as const,
          ]),
    ]),
    SPACER,
    line([
      { text: 'Cache: ', dim: true },
      {
        text: runtimeLocationText(result.cache, result.inspectionUnavailable === true),
      },
    ]),
    ...(result.cache.exists && result.inspectionUnavailable !== true
      ? [line([{ text: 'Cache identity: ', dim: true }, { text: result.cache.identityStrength }])]
      : []),
    line([
      { text: 'Project: ', dim: true },
      {
        text: runtimeLocationText(result.project, result.inspectionUnavailable === true),
      },
    ]),
    line([{ text: 'Evidence database: ', dim: true }, { text: evidenceDatabaseText(result) }]),
    ...(result.leaseActivity === undefined
      ? []
      : [
          line([
            { text: 'Runtime activity: ', dim: true },
            {
              text:
                `${String(result.leaseActivity.activeReaders)} other reader(s)` +
                (result.leaseActivity.writerPending ? ' · writer pending' : ''),
            },
          ]),
        ]),
    SPACER,
    line([
      { text: 'Adoption: ', dim: true },
      { text: result.adoptionState, tone: adoption.tone },
    ]),
    line([{ text: adoption.text, tone: adoption.tone }]),
  ];

  if (result.cleanupPending === true) {
    children.push(
      line([
        { text: 'Cleanup: ', dim: true },
        { text: result.recoveryReasonCode, tone: 'warning' },
      ]),
      line([{ text: CLEANUP_PENDING_TEXT, tone: 'warning' }]),
      line([
        { text: 'Source evidence: ', dim: true },
        { text: sourceDispositionText(result.sourcePreserved) },
      ]),
      line([{ text: `Run: ${result.recoveryCommand}`, tone: 'brand' }]),
    );
  } else if (result.adoptionState === 'recovery-required') {
    children.push(
      line([
        { text: 'Recovery: ', dim: true },
        { text: `${result.recoveryPhase} · ${result.recoveryReasonCode}` },
      ]),
      line([
        { text: 'Source evidence: ', dim: true },
        { text: sourceDispositionText(result.sourcePreserved) },
      ]),
      line([{ text: `Run: ${result.recoveryCommand}`, tone: 'brand' }]),
    );
  }

  children.push(
    SPACER,
    line([{ text: 'Retention', bold: true }]),
    line([
      { text: 'Cache entries: ', dim: true },
      {
        text: `keep ${String(result.retention.cache.keep)} · ${String(result.retention.cache.maxAgeDays)} days`,
      },
    ]),
    line([
      { text: 'Evidence: ', dim: true },
      {
        text:
          `keep ${String(result.retention.evidence.keep)} · ` +
          `${String(result.retention.evidence.maxAgeDays)} days · ` +
          `${String(result.retention.evidence.maxSizeMb)} MB`,
      },
    ]),
  );

  if (result.nextCommands.length > 0) {
    children.push(
      SPACER,
      line([{ text: 'Next', bold: true }]),
      ...result.nextCommands.map((command) => line([{ text: command, tone: 'brand' }])),
    );
  }

  return group(children, 2);
}
