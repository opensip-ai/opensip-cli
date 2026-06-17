/**
 * @fileoverview ADR dogfood checks for config, release, flags, and recipes.
 *
 * These checks intentionally encode opensip-cli-specific workflow names,
 * command files, config-loader bridge files, and recipe module layout.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { defineCheck } from '@opensip-cli/fitness';

const ROOT = process.cwd();

function relPath(filePath) {
  const raw = path.isAbsolute(filePath) ? path.relative(ROOT, filePath) : filePath;
  return raw.replaceAll('\\', '/');
}

function absPath(relativePath) {
  return path.join(ROOT, relativePath);
}

function isTestOrFixture(filePath) {
  const rel = relPath(filePath);
  return (
    /\/__tests__\//.test(rel) ||
    /\/__fixtures__\//.test(rel) ||
    /\/fixtures?\//.test(rel) ||
    /\.test\.tsx?$/.test(rel)
  );
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function lineOfNeedle(content, needle) {
  const index = content.indexOf(needle);
  return index < 0 ? 1 : lineOf(content, index);
}

function violation(filePath, line, type, message, suggestion) {
  return { filePath, line, type, message, severity: 'error', suggestion };
}

function readWorkspaceFile(relativePath) {
  const fullPath = absPath(relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
}

async function readAccessorFile(files, relativePath) {
  const match = files.paths.find((p) => relPath(p) === relativePath);
  if (match !== undefined) return [match, await files.read(match)];
  const content = readWorkspaceFile(relativePath);
  return content === undefined ? undefined : [absPath(relativePath), content];
}

// ---------------------------------------------------------------------------
// ADR-0017 / ADR-0020: release lane mirrors the correctness gates before pack.
// ---------------------------------------------------------------------------

const RELEASE_GATE_COMMANDS = [
  { release: 'pnpm lint', ci: ['pnpm lint'] },
  { release: 'pnpm test:coverage', ci: ['pnpm test:coverage'] },
  { release: 'pnpm fit:ci', ci: ['pnpm fit:ci'] },
  {
    release: 'pnpm graph:ci',
    ci: ['pnpm graph:ci', 'node packages/cli/dist/index.js graph --gate-save'],
  },
];

function analyzeReleaseGateParity() {
  const releaseRel = '.github/workflows/release.yml';
  const ciRel = '.github/workflows/ci.yml';
  const release = readWorkspaceFile(releaseRel);
  const ci = readWorkspaceFile(ciRel);
  const releasePath = absPath(releaseRel);
  const violations = [];
  if (release === undefined) {
    return [
      violation(
        releasePath,
        1,
        'release-workflow-missing',
        'Release workflow is missing; ADR-0017 requires a release lane gate.',
        'Restore .github/workflows/release.yml with the correctness gates before pack/publish.',
      ),
    ];
  }

  const packIndex = release.indexOf('Pack all workspace packages');
  const beforePack = packIndex < 0 ? release.length : packIndex;
  for (const command of RELEASE_GATE_COMMANDS) {
    const releaseIndex = release.indexOf(`run: ${command.release}`);
    if (releaseIndex < 0 || releaseIndex > beforePack) {
      violations.push(
        violation(
          releasePath,
          packIndex < 0 ? 1 : lineOf(release, packIndex),
          'release-gate-missing-before-pack',
          `Release workflow must run '${command.release}' before packing packages (ADR-0017).`,
          'Mirror the CI correctness gate before pack/publish so immutable npm artifacts cannot bypass PR-lane checks.',
        ),
      );
    }
    if (ci !== undefined && !command.ci.some((ciCommand) => ci.includes(`run: ${ciCommand}`))) {
      violations.push(
        violation(
          absPath(ciRel),
          1,
          'ci-release-gate-drift',
          `CI workflow no longer contains a counterpart for '${command.release}', so release parity cannot be established (ADR-0017).`,
          'Keep the PR-lane and release-lane correctness gates aligned, or update this local check with the new canonical command.',
        ),
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ADR-0023: one config document, with sanctioned readers allowlisted.
// ---------------------------------------------------------------------------

const YAML_READER_RE =
  /\breadYamlFile(?:OrThrow)?\s*\(|^\s*import\s+\{[^}]*\bparse\s+as\s+parseYaml\b[^}]*\}\s+from\s+['"]yaml['"]|^\s*import\s+\{[^}]*\bparseDocument\b[^}]*\}\s+from\s+['"]yaml['"]/m;

const CONFIG_READER_ALLOWLIST = new Set([
  'packages/config/src/document/cli-config.ts',
  'packages/config/src/document/global-config.ts',
  'packages/core/src/lib/config-version.ts',
  'packages/core/src/lib/yaml.ts',
  'packages/core/src/plugins/discover.ts',
  'packages/cli/src/bootstrap/config-and-capabilities.ts',
  'packages/cli/src/commands/plugin/config-edit.ts',
  'packages/fitness/engine/src/signalers/loader.ts',
  'packages/fitness/engine/src/targets/loader.ts',
  'packages/graph/engine/src/cli/graph-config.ts',
  'packages/simulation/engine/src/cli/sim-config.ts',
]);

function analyzeOneConfigDocumentRatchet(content, filePath) {
  const rel = relPath(filePath);
  if (/^packages\/fitness\/checks-[^/]+\//.test(rel)) return [];
  if (isTestOrFixture(rel) || CONFIG_READER_ALLOWLIST.has(rel)) return [];
  if (!YAML_READER_RE.test(content)) return [];
  return [
    violation(
      filePath,
      lineOfNeedle(content, 'readYamlFile'),
      'config-yaml-reader-outside-allowlist',
      'New opensip-cli.config.yml readers must not appear outside the sanctioned config/loading seams (ADR-0023).',
      'Route config through the composed document loader or add a narrow allowlist entry here with the ADR-specific bridge justification.',
    ),
  ];
}

// ---------------------------------------------------------------------------
// ADR-0021: primary tool run commands share the mandatory common flags.
// ---------------------------------------------------------------------------

const PRIMARY_COMMAND_SPEC_FILES = {
  fit: 'packages/fitness/engine/src/cli/fit/fit-command-spec.ts',
  graph: 'packages/graph/engine/src/cli/graph/graph-command-spec.ts',
  simulation: 'packages/simulation/engine/src/tool.ts',
};

function extractStringArray(source, bindingRegex) {
  const match = bindingRegex.exec(source);
  if (match === null) return undefined;
  const values = [];
  for (const value of match[1].matchAll(/['"]([A-Za-z][A-Za-z0-9]*)['"]/g)) {
    values.push(value[1]);
  }
  return values;
}

function extractMandatoryCommonFlags(content) {
  return extractStringArray(content, /MANDATORY_COMMON_FLAGS[^=]*=\s*\[([\s\S]*?)\]\s*as\s+const/);
}

function extractCommonFlags(content) {
  return extractStringArray(content, /commonFlags\s*:\s*\[([\s\S]*?)\]/);
}

async function analyzeCrossToolFlagParity(files) {
  const contract = await readAccessorFile(files, 'packages/contracts/src/cli-flags.ts');
  if (contract === undefined) return [];
  const mandatory = extractMandatoryCommonFlags(contract[1]);
  if (mandatory === undefined || mandatory.length === 0) {
    return [
      violation(
        contract[0],
        1,
        'common-flags-unreadable',
        'Could not read MANDATORY_COMMON_FLAGS from the common flag registry (ADR-0021).',
        'Keep MANDATORY_COMMON_FLAGS as the single literal array the tools can be checked against.',
      ),
    ];
  }

  const violations = [];
  for (const [tool, relativePath] of Object.entries(PRIMARY_COMMAND_SPEC_FILES)) {
    const file = await readAccessorFile(files, relativePath);
    if (file === undefined) {
      violations.push(
        violation(
          absPath(relativePath),
          1,
          'primary-command-spec-missing',
          `${tool} primary command spec could not be read for ADR-0021 flag parity.`,
          'Keep each primary run command in the expected tool-owned spec file, or update this dogfood check with the new location.',
        ),
      );
      continue;
    }
    const flags = extractCommonFlags(file[1]);
    if (flags === undefined) {
      violations.push(
        violation(
          file[0],
          1,
          'common-flags-missing',
          `${tool} primary command does not declare a commonFlags array (ADR-0021).`,
          'Declare commonFlags from the registry on the primary run command spec.',
        ),
      );
      continue;
    }
    const present = new Set(flags);
    for (const flag of mandatory) {
      if (!present.has(flag)) {
        violations.push(
          violation(
            file[0],
            lineOfNeedle(file[1], 'commonFlags'),
            'mandatory-common-flag-missing',
            `${tool} primary command is missing mandatory common flag '${flag}' (ADR-0021).`,
            'Add the flag key to the command spec commonFlags array; flag spelling and help text stay in contracts/src/cli-flags.ts.',
          ),
        );
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ADR-0026: graph recipes select rules; execution stays tool-owned.
// ---------------------------------------------------------------------------

async function analyzeRecipeSemantics(files) {
  const violations = [];
  const schedulerFiles = [
    'packages/fitness/engine/src/recipes/parallel-execution.ts',
    'packages/fitness/engine/src/recipes/sequential-execution.ts',
    'packages/simulation/engine/src/recipes/service.ts',
  ];
  for (const relativePath of schedulerFiles) {
    const file = await readAccessorFile(files, relativePath);
    if (file === undefined || !file[1].includes('scheduleUnits')) {
      violations.push(
        violation(
          absPath(relativePath),
          1,
          'recipe-scheduler-not-shared',
          `${relativePath} must route execution scheduling through core scheduleUnits (ADR-0026).`,
          'Keep shared recipe execution semantics in @opensip-cli/core and tool-specific setup in the tool package.',
        ),
      );
    }
  }
  return violations;
}

function analyzeGraphRecipeSelectionOnly(content, filePath) {
  const rel = relPath(filePath);
  if (isTestOrFixture(rel)) return [];
  if (!/^packages\/graph\/engine\/src\/recipes\//.test(rel)) return [];
  const violations = [];
  const forbidden = [/\bexecution\s*:/g, /\breporting\s*:/g];
  for (const regex of forbidden) {
    for (const match of content.matchAll(regex)) {
      violations.push(
        violation(
          filePath,
          lineOf(content, match.index ?? 0),
          'graph-recipe-execution-block',
          'Graph recipes must stay selection-only; graph execution is tool-owned (ADR-0026).',
          'Keep execution/reporting blocks out of GraphRecipe. Select rules with the recipe; run/evaluate semantics stay in the graph engine.',
        ),
      );
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '490678ef-729f-423d-bffa-5b9acca74d20',
    slug: 'dogfood-release-gate-parity',
    description:
      'release workflow must run the PR-lane correctness gates before pack/publish (ADR-0017/0020)',
    scope: { languages: ['typescript'], concerns: ['config'] },
    tags: ['architecture', 'release', 'dogfood'],
    contentFilter: 'raw',
    analyzeAll: async () => analyzeReleaseGateParity(),
  }),
  defineCheck({
    id: 'f41b930f-f9d4-46a4-8629-e7e65faa4d72',
    slug: 'dogfood-one-config-document-ratchet',
    description:
      'new YAML config readers must stay behind the sanctioned config/loading seams (ADR-0023)',
    scope: {
      languages: ['typescript'],
      concerns: ['backend', 'cli', 'config'],
    },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: analyzeOneConfigDocumentRatchet,
  }),
  defineCheck({
    id: '3481575e-91e9-49dc-91a5-77c147e5f16d',
    slug: 'dogfood-cross-tool-flag-parity',
    description:
      'primary fit/graph/sim run commands must include every mandatory common flag from the shared registry (ADR-0021)',
    scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyzeAll: analyzeCrossToolFlagParity,
  }),
  defineCheck({
    id: 'af337d9c-5853-43da-8715-1b77d0ba4aca',
    slug: 'dogfood-graph-recipes-selection-only',
    description:
      'graph recipes select rules only; shared execution semantics stay in scheduleUnits and tool-owned runners (ADR-0026)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts'],
    contentFilter: 'strip-strings-and-comments',
    analyze: analyzeGraphRecipeSelectionOnly,
  }),
  defineCheck({
    id: '1f068b65-3b33-40b8-b366-72c7f586414a',
    slug: 'dogfood-shared-recipe-scheduler',
    description:
      'fitness and simulation recipe execution must route through the shared scheduleUnits substrate (ADR-0026)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyzeAll: analyzeRecipeSemantics,
  }),
];
