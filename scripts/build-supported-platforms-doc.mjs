#!/usr/bin/env node
/**
 * build-supported-platforms-doc — generate
 * docs/public/70-reference/17-supported-platforms.md from the BUILT core
 * platform-support registry (`packages/core/dist/index-lib.js`).
 *
 * The public support matrix must never diverge from the policy the CLI/MCP
 * catalogs and the acceptance harness classify against, so it is generated, not
 * hand-maintained. Output is deterministic and byte-stable (no timestamps): a
 * given registry + release version always renders the same bytes, and `--check`
 * fails on drift.
 *
 * Generation fails closed on an internally inconsistent registry: duplicate or
 * overlapping rows, an unknown status, a missing docs/profile/evidence link, an
 * `unsupported` row without a reason, or a `supported` row missing the exact
 * qualification metadata Phase 0 requires.
 *
 * macOS launches as `preview` in the registry; this generator renders whatever
 * status the row carries — it never hardcodes `supported`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_PATH = join(REPO_ROOT, 'docs/public/70-reference/17-supported-platforms.md');
const CORE_LIB = join(REPO_ROOT, 'packages/core/dist/index-lib.js');
const GENERATOR_REL = 'scripts/build-supported-platforms-doc.mjs';
const REGISTRY_REL = 'packages/core/src/lib/platform-support.ts';
const ACCEPTANCE_PROFILE_DIR = '.config/platform-acceptance';
/** Fixed verification stamp — deterministic (byte-stable), never `Date.now()`. */
const LAST_VERIFIED = '2026-07-14';

const KNOWN_STATUSES = new Set(['supported', 'preview', 'unqualified', 'unsupported']);

const log = (msg) => console.error(`[build-supported-platforms-doc] ${msg}`);

/**
 * Fail-closed validation of the frozen registry from the generator's own
 * perspective (independent of the core module-load assertions). Throws on the
 * first inconsistency so a bad registry can never publish a bad matrix.
 *
 * @param {readonly any[]} rows PLATFORM_SUPPORT_ROWS
 */
export function validateSupportRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('platform-support registry is empty');
  }
  const ids = new Set();
  const discriminators = new Set();
  for (const row of rows) {
    if (!KNOWN_STATUSES.has(row.status)) {
      throw new Error(`row ${row.id}: unknown status '${row.status}'`);
    }
    if (ids.has(row.id)) throw new Error(`duplicate platform-support row id: ${row.id}`);
    ids.add(row.id);
    const discriminator = `${row.tuple.osPlatform}|${String(row.tuple.osVersionMajor)}|${row.tuple.arch}`;
    if (discriminators.has(discriminator)) {
      throw new Error(`overlapping platform-support rows for tuple ${discriminator}`);
    }
    discriminators.add(discriminator);

    if (!row.docsPath || !row.docsUrl) {
      throw new Error(`row ${row.id}: missing docs link (docsPath/docsUrl)`);
    }
    if (!row.notes || row.notes.trim().length === 0) {
      const what =
        row.status === 'unsupported' ? 'unsupported row without a reason' : 'missing notes';
      throw new Error(`row ${row.id}: ${what}`);
    }
    if (
      (row.status === 'preview' || row.status === 'supported') &&
      (row.profile === undefined || !row.profile.id || typeof row.profile.version !== 'number')
    ) {
      throw new Error(`row ${row.id}: ${row.status} row missing a qualification profile link`);
    }
    if (row.status === 'supported') {
      if (row.evidence === undefined || !row.evidence.url) {
        throw new Error(`row ${row.id}: supported row missing a published evidence link`);
      }
      if (
        row.qualification === undefined ||
        typeof row.qualification.consecutiveDailyPasses !== 'number' ||
        !row.qualification.qualifiedVersion ||
        !row.qualification.qualifiedAt
      ) {
        throw new Error(`row ${row.id}: supported row missing exact qualification metadata`);
      }
    }
  }
  return rows;
}

/** Distinct acceptance-profile config paths for rows that declare a profile. */
export function profileConfigPaths(rows) {
  const paths = new Set();
  for (const row of rows) {
    if (row.profile?.id) paths.add(`${ACCEPTANCE_PROFILE_DIR}/${row.profile.id}.json`);
  }
  return [...paths].sort();
}

function renderTupleTable(tuple) {
  const rows = [
    [
      'Operating system',
      `${tuple.osName} ${tuple.osVersionRange} (\`process.platform\` = \`${tuple.osPlatform}\`)`,
    ],
    ['Kernel', `${tuple.kernelName} ${tuple.kernelVersionRange}`],
    ['Architecture', `\`${tuple.arch}\` (\`process.arch\`)`],
    ['Node.js', `${String(tuple.nodeVersionMajor)}.x (module ABI \`${tuple.nodeAbi}\`)`],
    ['npm', `${String(tuple.npmVersionMajor)}.x`],
    [
      'Filesystem',
      `${tuple.filesystemType} (${tuple.caseSensitive ? 'case-sensitive' : 'case-insensitive'})`,
    ],
    ['Install channels', tuple.installChannels.map((c) => `\`${c}\``).join(', ')],
  ];
  return [
    '| Dimension | Requirement |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join('\n');
}

function evidenceLinkLine(row) {
  if (row.evidence === undefined) return '';
  if (row.evidence.url) return `Published evidence: ${row.evidence.url}`;
  return 'Published evidence link: not yet available — the row is in burn-in and the link is attached on promotion to `supported`.';
}

function renderEvidence(row) {
  if (row.status === 'unsupported') {
    return 'No qualification evidence is collected for this tuple; it is intentionally excluded.';
  }
  const profile = row.profile
    ? `Acceptance profile \`${row.profile.id}\` (version ${String(row.profile.version)}), stored at \`${ACCEPTANCE_PROFILE_DIR}/${row.profile.id}.json\`.`
    : 'No acceptance profile is bound to this row.';
  const artifact = row.evidence?.artifact
    ? `Release evidence artifact: \`${row.evidence.artifact}\`.`
    : 'No release evidence artifact is declared.';
  const qualification = row.qualification
    ? `Burn-in: ${String(row.qualification.consecutiveDailyPasses)} consecutive daily passes; qualified at version ${row.qualification.qualifiedVersion} on ${row.qualification.qualifiedAt}.`
    : '';
  return [profile, artifact, evidenceLinkLine(row), qualification]
    .filter((s) => s.length > 0)
    .join(' ');
}

function renderRowSection(row) {
  return [
    `### ${row.tuple.osName} ${row.tuple.osVersionRange} on ${row.tuple.arch} — \`${row.status}\``,
    '',
    `Row id: \`${row.id}\``,
    '',
    renderTupleTable(row.tuple),
    '',
    row.notes,
    '',
    renderEvidence(row),
  ].join('\n');
}

/**
 * Render the full public Supported Platforms page from the registry rows.
 *
 * @param {readonly any[]} rawRows PLATFORM_SUPPORT_ROWS
 * @param {number} contractVersion PLATFORM_SUPPORT_CONTRACT_VERSION
 * @param {string} releaseVersion e.g. `v0.7.0`
 * @returns {string}
 */
export function renderSupportedPlatformsDoc(rawRows, contractVersion, releaseVersion) {
  const rows = validateSupportRows(rawRows);
  const sourceFiles = [REGISTRY_REL, GENERATOR_REL, ...profileConfigPaths(rows)];

  const matrixRows = rows
    .map((row) => {
      const t = row.tuple;
      const os = `${t.osName} ${t.osVersionRange}`;
      const node = `${String(t.nodeVersionMajor)}.x (ABI ${t.nodeAbi})`;
      const fs = `${t.filesystemType} (${t.caseSensitive ? 'case-sensitive' : 'case-insensitive'})`;
      return `| \`${row.id}\` | \`${row.status}\` | ${os} | \`${t.arch}\` | ${node} | ${String(t.npmVersionMajor)}.x | ${fs} |`;
    })
    .join('\n');

  const frontmatter = [
    '---',
    'status: current',
    `last_verified: ${LAST_VERIFIED}`,
    `release: ${releaseVersion}`,
    'title: "Supported platforms"',
    'audience: [getting-started, ci-integrators, contributors]',
    'purpose: "The generated, authoritative host-support matrix: the exact qualified tuple, its status, explicitly unsupported hosts, and what unqualified means."',
    'source-files:',
    ...sourceFiles.map((f) => `  - ${f}`),
    'related-docs:',
    '  - ./15-compatibility-policy.md',
    '  - ./13-verifiable-releases.md',
    '  - ../00-start/00-quick-start.md',
    '  - ../00-start/04-faq.md',
    '---',
  ].join('\n');

  const body = [
    '<!-- Generated by scripts/build-supported-platforms-doc.mjs — do not edit by hand.',
    '     Run `pnpm docs:platform-support`. CI enforces sync via `pnpm docs:platform-support:check`. -->',
    '',
    '# Supported platforms',
    '',
    `The npm package declares \`engines.node: ">=24"\`, which is an install/runtime`,
    'floor — not a support claim. Qualified support is narrower than "any host that',
    'can run Node 24": it names an exact host tuple with measured evidence. This',
    'page is generated from the platform-support policy registry',
    `([\`${REGISTRY_REL}\`](../../../${REGISTRY_REL})) and is the authoritative`,
    'matrix. The same registry drives the CLI/MCP agent catalogs and the release',
    'acceptance harness, so human and machine claims cannot drift.',
    '',
    `Platform-support contract version: **${String(contractVersion)}**. See the`,
    '[`platform-support` compatibility class](./15-compatibility-policy.md) for the',
    'versioning, deprecation, and change-gate rules.',
    '',
    '## Support status vocabulary',
    '',
    'Every host resolves to exactly one of four statuses. `unqualified` never means',
    '"cannot run" — it means "not measured by this contract, so no promise".',
    '',
    '| Status | Meaning |',
    '|---|---|',
    '| `supported` | Measured tuple past burn-in; every release is gated by verified evidence. Never implied by package engine compatibility. |',
    '| `preview` | Published tuple with useful evidence but documented gaps; not yet burn-in-complete. |',
    '| `unqualified` | Not measured by this contract. May work; no promise. Anything not listed below is unqualified. |',
    '| `unsupported` | Intentionally excluded — absent evidence or a known limitation. |',
    '',
    '## Matrix',
    '',
    '| Row | Status | OS | Arch | Node | npm | Filesystem |',
    '|---|---|---|---|---|---|---|',
    matrixRows,
    '',
    '## Host details',
    '',
    ...rows.flatMap((row) => [renderRowSection(row), '']),
    '## Unqualified hosts and unqualified dimensions',
    '',
    'Any host tuple not listed above is `unqualified`: other macOS versions, Linux,',
    'Windows, other architectures, other Node or npm majors, other filesystems, and',
    'case-sensitive volumes. Unqualified hosts may work perfectly well — the CLI',
    'does not block them and never claims they "cannot run" — but they carry no',
    'evidence-backed promise. Individual dimensions are also unqualified when they',
    'cannot be observed at classification time (see the agent projection below):',
    'npm version, filesystem type, case behavior, install channel, and the OS/kernel',
    'product versions are frequently unobserved during an ordinary command.',
    '',
    '## Install channels',
    '',
    'A qualified tuple is only qualified through its listed install channels — the',
    'exact npm version and the canonical `install.sh` installer. Other install paths',
    '(a Homebrew formula, a distro package, a from-source build) are not part of the',
    'qualified claim and are treated as unqualified until they carry their own',
    'evidence plan.',
    '',
    '## Agents and MCP',
    '',
    'AI agents read the same registry through the machine catalog. `opensip',
    'agent-catalog --json` (and the MCP `get_agent_catalog` tool) carry a',
    '`hostSupport` projection built only from process-observable facts',
    '(`process.platform`, `process.arch`, `process.version`,',
    '`process.versions.modules`). Because npm, filesystem, case behavior, install',
    'channel, and OS/kernel product versions are unobserved at runtime, the local',
    '`match` is never `exact` — it is `partial` on a clean match and `none` on a',
    "contradiction. Agents must distinguish the registry row's published `status`",
    '(e.g. `preview`) from the local `match`:',
    '',
    '```json',
    '{',
    '  "hostSupport": {',
    `    "supportContractVersion": ${String(contractVersion)},`,
    '    "status": "preview",',
    '    "match": "partial",',
    '    "rowId": "macos-26-arm64-node24-npm11-v1",',
    '    "rowStatus": "preview",',
    '    "matrixUrl": "https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms",',
    '    "reasonCodes": [],',
    '    "observed": ["os-platform", "arch", "node-major", "node-abi"],',
    '    "unobserved": ["os-version", "kernel-version", "npm-major", "filesystem-type", "case-sensitivity", "install-channel"]',
    '  }',
    '}',
    '```',
    '',
    'A non-macOS host projects `status: "unqualified"`, `match: "none"`, and',
    '`reasonCodes: ["non-macos-host"]`; Intel/x64 macOS projects `status:',
    '"unsupported"` with `reasonCodes: ["macos-intel-unsupported"]`. The CLI and MCP',
    'surfaces map the same core projection through one shared helper, so they emit a',
    'byte-identical `hostSupport` for identical process facts.',
    '',
    '## `engines` is not a support claim',
    '',
    'The package `engines.node` range only gates installation on a too-old Node. It',
    'says nothing about OS, kernel, architecture, Node ABI, npm major, filesystem, or',
    'case behavior — the dimensions this matrix qualifies. Passing the engine check',
    'is necessary, not sufficient, for a supported host.',
    '',
    '## Release evidence',
    '',
    'A `supported` row is promoted only after burn-in: an exact staged version whose',
    'required release journeys all pass, with the acceptance evidence artifact',
    'attached to the corresponding GitHub Release. A *required* journey that is',
    'skipped fails the gate — a skipped required check is treated as missing',
    'evidence, not as a pass. Until promotion, a row stays `preview` and its',
    'evidence link is absent.',
    '',
    '## Reporting a host',
    '',
    'To request qualification of a host tuple, or to report behavior on an',
    'unqualified one, open a GitHub issue with your `opensip agent-catalog --json`',
    '`hostSupport` block, the output of `node --version`, `npm --version`,',
    '`sw_vers -productVersion`, `uname -r`, and — if you ran the acceptance harness —',
    'the evidence artifact digest. That tuple + evidence digest is what a new support',
    'row is built from.',
    '',
    '## Related',
    '',
    '- [Compatibility policy](./15-compatibility-policy.md)',
    '- [Verifiable releases](./13-verifiable-releases.md)',
    '- [Quick start](../00-start/00-quick-start.md)',
    '- [FAQ](../00-start/04-faq.md)',
    '',
  ].join('\n');

  return `${frontmatter}\n${body}`;
}

async function loadRegistry() {
  if (!existsSync(CORE_LIB)) {
    throw new Error(
      `built core registry not found at ${CORE_LIB}. Run \`pnpm build\` (or \`pnpm --filter=@opensip-cli/core build\`) first.`,
    );
  }
  const mod = await import(pathToFileURL(CORE_LIB).href);
  return {
    rows: mod.PLATFORM_SUPPORT_ROWS,
    contractVersion: mod.PLATFORM_SUPPORT_CONTRACT_VERSION,
  };
}

function readReleaseVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  return `v${pkg.version}`;
}

/** Fail closed when a preview/supported row's acceptance-profile file is absent. */
function assertProfileArtifactsExist(rows) {
  for (const rel of profileConfigPaths(rows)) {
    if (!existsSync(join(REPO_ROOT, rel))) {
      throw new Error(`missing acceptance-profile link target: ${rel}`);
    }
  }
}

export async function buildSupportedPlatformsDoc(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const { rows, contractVersion } = await loadRegistry();
  assertProfileArtifactsExist(rows);
  const next = renderSupportedPlatformsDoc(rows, contractVersion, readReleaseVersion());
  const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : null;

  if (check) {
    if (current === next) {
      log('17-supported-platforms.md in sync.');
      return { changed: false };
    }
    log(
      'stale: docs/public/70-reference/17-supported-platforms.md — run pnpm docs:platform-support',
    );
    process.exit(1);
  }

  writeFileSync(OUT_PATH, next, 'utf8');
  log(`wrote docs/public/70-reference/17-supported-platforms.md (${String(rows.length)} rows).`);
  return { changed: current !== next };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildSupportedPlatformsDoc().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
