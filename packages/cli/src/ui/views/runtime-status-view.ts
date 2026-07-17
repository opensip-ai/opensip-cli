/** Compact, path-free human presentation for `opensip status`. */

import { group, line, type Tone, type ViewNode } from '@opensip-cli/cli-ui';

import { formatBytes } from '../../format-bytes.js';

import type { RuntimeStatusResult } from '@opensip-cli/contracts';

const SPACER: ViewNode = { kind: 'spacer' };

function runtimeLocationText(
  location: RuntimeStatusResult['cache'] | RuntimeStatusResult['project'],
): string {
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
  if (result.cleanupPending === true) {
    return {
      text:
        result.sourcePreserved === true
          ? 'Terminal cleanup is pending; the source evidence remains preserved.'
          : 'Terminal cleanup is pending; the current project evidence remains authoritative.',
      tone: 'warning',
    };
  }
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
      return {
        text: 'Cache identity is unverified; choose the source explicitly with opensip init.',
        tone: 'warning',
      };
    }
    case 'conflict': {
      return {
        text: 'Cache and project evidence both exist; resolve the conflict explicitly with opensip init.',
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
  if (result.activePlane === 'cache') return 'user cache';
  return result.activePlane;
}

function evidenceDatabaseText(result: RuntimeStatusResult): string {
  if (!result.evidenceDatabase.exists) return 'not present';
  if (result.evidenceDatabase.sizeBytes === undefined) return 'present · size unavailable';
  return `present · ${formatBytes(result.evidenceDatabase.sizeBytes)}`;
}

/** Render the customer-visible status projection without revealing filesystem locations. */
export function viewRuntimeStatus(result: RuntimeStatusResult): ViewNode {
  const activePlane = activePlaneLabel(result);
  const adoption = adoptionGuidance(result);
  const children: ViewNode[] = [
    line([{ text: 'OpenSIP evidence storage', bold: true }]),
    line([
      { text: 'Active: ', dim: true },
      { text: activePlane, tone: result.activePlane === 'none' ? 'muted' : 'brand' },
      {
        text: ` · project ${result.projectInitialized ? 'initialized' : 'not initialized'}`,
        dim: true,
      },
    ]),
    SPACER,
    line([{ text: 'Cache: ', dim: true }, { text: runtimeLocationText(result.cache) }]),
    ...(result.cache.exists
      ? [line([{ text: 'Cache identity: ', dim: true }, { text: result.cache.identityStrength }])]
      : []),
    line([{ text: 'Project: ', dim: true }, { text: runtimeLocationText(result.project) }]),
    line([{ text: 'Evidence database: ', dim: true }, { text: evidenceDatabaseText(result) }]),
    SPACER,
    line([
      { text: 'Adoption: ', dim: true },
      { text: result.adoptionState, tone: adoption.tone },
    ]),
    line([{ text: adoption.text, tone: adoption.tone }]),
  ];

  if (result.adoptionState === 'recovery-required' || result.cleanupPending === true) {
    children.push(
      line([
        { text: 'Recovery: ', dim: true },
        { text: `${result.recoveryPhase} · ${result.recoveryReasonCode}` },
      ]),
      line([
        { text: 'Source evidence: ', dim: true },
        { text: result.sourcePreserved === true ? 'preserved' : 'not preserved' },
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
