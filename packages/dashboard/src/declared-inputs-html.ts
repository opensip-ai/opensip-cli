/**
 * HTML fragments for the report "declared inputs" details panel.
 */

import type { DeclaredInputs } from '@opensip-cli/contracts';

const OPENSIP_CLI_REPOSITORY_URL = 'https://github.com/opensip-ai/opensip-cli';
const RELEASE_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function githubReleaseUrlForCliVersion(cliVersion: string): string | undefined {
  const version = cliVersion.trim();
  if (!RELEASE_VERSION_RE.test(version)) return undefined;
  const tagName = `v${version}`;
  return `${OPENSIP_CLI_REPOSITORY_URL}/releases/tag/${encodeURIComponent(tagName)}`;
}

function renderCliVersionValue(cliVersion: string): string {
  const escapedVersion = escapeHtml(cliVersion);
  const releaseUrl = githubReleaseUrlForCliVersion(cliVersion);
  if (releaseUrl === undefined) return escapedVersion;
  return `<a class="report-details-link" href="${escapeHtml(releaseUrl)}" target="_blank" rel="noopener noreferrer" title="View OpenSIP CLI v${escapedVersion} on GitHub">${escapedVersion}</a>`;
}

/**
 * Render the collapsible "Report details" panel for host-declared run environment.
 * Empty string when no inputs were supplied.
 */
export function renderDeclaredInputs(input: DeclaredInputs | undefined): string {
  if (input === undefined) return '';
  // Only Engine (a tool's manifest version) and Baseline (a gate's fingerprint
  // identity) are meaningful for a TOOL run. The report itself is a host command
  // with neither, so those rows are omitted rather than rendered as "unknown".
  // Package manager is likewise omitted when it can't be resolved.
  const pairs: (readonly [string, string])[] = [
    ['CLI', renderCliVersionValue(input.cliVersion)],
    ['Node', escapeHtml(input.nodeVersion)],
  ];
  if (input.packageManager !== undefined) {
    pairs.push(['Package manager', escapeHtml(input.packageManager)]);
  }
  pairs.push(['Platform', escapeHtml(input.platform)], ['Tool', escapeHtml(input.tool)]);
  if (input.engineVersion !== undefined) pairs.push(['Engine', escapeHtml(input.engineVersion)]);
  if (input.baselineIdentity !== undefined) {
    pairs.push([
      'Baseline',
      escapeHtml(
        `${input.baselineIdentity.fingerprintStrategyId}@${input.baselineIdentity.fingerprintStrategyVersion}`,
      ),
    ]);
  }
  const rows = pairs
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`)
    .join('');
  return `<details class="report-details"><summary><span class="report-details-version">CLI ${escapeHtml(input.cliVersion)}</span><span class="report-details-label">Report details</span></summary><div class="report-details-panel"><div class="report-details-title">Run environment</div><dl class="report-details-list">${rows}</dl></div></details>`;
}
