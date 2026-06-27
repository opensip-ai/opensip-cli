/**
 * @fileoverview ADR dogfood checks for plugin, manifest, and API contracts.
 *
 * These are opensip-cli self-checks: they know the first-party package names,
 * marker kinds, command-surface migration, and curated public barrel policy.
 */
import path from 'node:path';

import { defineCheck } from '@opensip-cli/fitness';

import { bundledToolPackageSegments, toolEnginePathRe } from './tool-engine-paths.mjs';

const ROOT = process.cwd();
const BUNDLED_TOOL_PACKAGE_NAMES = new Set(
  bundledToolPackageSegments.map((segment) => `@opensip-cli/${segment}`),
);
const TOOL_ENGINE_PATH = toolEnginePathRe();

function escapeRe(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function relPath(filePath) {
  const raw = path.isAbsolute(filePath) ? path.relative(ROOT, filePath) : filePath;
  return raw.replaceAll('\\', '/');
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

function jsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringSet(values) {
  return new Set(values.filter((v) => typeof v === 'string'));
}

// ---------------------------------------------------------------------------
// ADR-0009 / ADR-0013 / ADR-0027 / ADR-0029: bundled tools load by manifest.
// ---------------------------------------------------------------------------

const HOST_STATIC_TOOL_IMPORT_RE = new RegExp(
  String.raw`^\s*import\s+(?!type\b)[^;]+?\bfrom\s*['"]@opensip-cli/(?:${bundledToolPackageSegments
    .map(escapeRe)
    .join('|')}|checks-[^'"]+)['"]`,
  'gm',
);

function analyzeNoBootstrapToolImport(content, filePath) {
  const rel = relPath(filePath);
  if (isTestOrFixture(rel)) return [];
  if (!/^packages\/(?:cli|core)\/src\//.test(rel)) return [];
  if (rel === 'packages/cli/src/commands/init/config-templates.ts') return [];

  const violations = [];
  for (const match of content.matchAll(HOST_STATIC_TOOL_IMPORT_RE)) {
    violations.push(
      violation(
        filePath,
        lineOf(content, match.index ?? 0),
        'bootstrap-static-tool-import',
        'CLI/core production code must not statically import bundled tools or check packs (ADR-0009/0027/0029).',
        'Resolve the package manifest on disk and load the tool or contribution through the shared manifest/import path.',
      ),
    );
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ADR-0007 / ADR-0023 / ADR-0027: local marker kinds and tool manifests.
// ---------------------------------------------------------------------------

function expectedPackageKind(pkgName) {
  if (pkgName.startsWith('@opensip-cli/checks-')) return 'fit-pack';
  if (
    pkgName.startsWith('@opensip-cli/graph-') &&
    pkgName !== '@opensip-cli/graph' &&
    pkgName !== '@opensip-cli/graph-adapter-common'
  ) {
    return 'graph-adapter';
  }
  if (BUNDLED_TOOL_PACKAGE_NAMES.has(pkgName)) {
    return 'tool';
  }
  return undefined;
}

function expectedCapabilityIds(pkgName) {
  if (pkgName === '@opensip-cli/fitness') return ['fit-pack', 'fit-recipe'];
  if (pkgName === '@opensip-cli/graph') return ['graph-adapter'];
  if (pkgName === '@opensip-cli/simulation') return ['sim-pack', 'sim-recipe'];
  return [];
}

function analyzePackageManifest(pkg, filePath) {
  if (typeof pkg.name !== 'string') return [];
  const expectedKind = expectedPackageKind(pkg.name);
  if (expectedKind === undefined) return [];

  const rel = relPath(filePath);
  const block = pkg.opensipTools;
  const violations = [];
  if (!jsonObject(block)) {
    return [
      violation(
        filePath,
        1,
        'opensip-cli-manifest-missing',
        `${rel}: ${pkg.name} must declare package.json#opensipTools.kind='${expectedKind}'.`,
        'Add the static opensipTools manifest so discovery/admission can classify the package before importing runtime code.',
      ),
    ];
  }
  if (block.kind !== expectedKind) {
    violations.push(
      violation(
        filePath,
        1,
        'opensip-cli-kind-drift',
        `${rel}: ${pkg.name} must use opensipTools.kind='${expectedKind}' (got ${JSON.stringify(block.kind)}).`,
        'Keep first-party marker kinds in package.json so plugin discovery stays data-driven and source-independent.',
      ),
    );
  }

  if (expectedKind === 'tool') {
    if (typeof block.id !== 'string' || block.id.length === 0) {
      violations.push(
        violation(
          filePath,
          1,
          'tool-manifest-id-missing',
          `${rel}: tool manifest must declare a non-empty opensipTools.id.`,
          'The host admission gate needs a stable tool id before importing runtime code.',
        ),
      );
    }
    if (typeof block.apiVersion !== 'number') {
      violations.push(
        violation(
          filePath,
          1,
          'tool-manifest-api-version-missing',
          `${rel}: tool manifest must declare numeric opensipTools.apiVersion.`,
          'The host admission gate needs the API epoch before importing runtime code.',
        ),
      );
    }
    if (!Array.isArray(block.commands) || block.commands.length === 0) {
      violations.push(
        violation(
          filePath,
          1,
          'tool-manifest-commands-missing',
          `${rel}: tool manifest must declare a non-empty opensipTools.commands array.`,
          'Keep command identity in the static manifest so the host can reason about command surface before loading the tool.',
        ),
      );
    }
    const capabilities = Array.isArray(block.capabilities) ? block.capabilities : [];
    const actualIds = stringSet(capabilities.map((c) => c?.id));
    for (const capabilityId of expectedCapabilityIds(pkg.name)) {
      if (!actualIds.has(capabilityId)) {
        violations.push(
          violation(
            filePath,
            1,
            'tool-manifest-capability-missing',
            `${rel}: ${pkg.name} manifest must declare capability '${capabilityId}'.`,
            'Capability domains are manifest data, not host-compiled constants (ADR-0023).',
          ),
        );
      }
    }
    for (const capability of capabilities) {
      if (!jsonObject(capability)) continue;
      const capabilityId =
        typeof capability.id === 'string' ? capability.id : '<unknown-capability>';
      if (typeof capability.apiVersion !== 'number') {
        violations.push(
          violation(
            filePath,
            1,
            'tool-manifest-capability-api-version-missing',
            `${rel}: capability '${capabilityId}' must declare numeric apiVersion.`,
            'Capability domains declare a current contribution-contract epoch in the manifest (ADR-0074).',
          ),
        );
      }
      if (typeof capability.minSupportedApiVersion !== 'number') {
        violations.push(
          violation(
            filePath,
            1,
            'tool-manifest-capability-min-supported-missing',
            `${rel}: capability '${capabilityId}' must declare numeric minSupportedApiVersion.`,
            'Capability domains declare the oldest accepted contribution epoch in the manifest (ADR-0074).',
          ),
        );
      }
      if (
        typeof capability.apiVersion === 'number' &&
        typeof capability.minSupportedApiVersion === 'number' &&
        capability.minSupportedApiVersion > capability.apiVersion
      ) {
        violations.push(
          violation(
            filePath,
            1,
            'tool-manifest-capability-range-invalid',
            `${rel}: capability '${capabilityId}' has minSupportedApiVersion > apiVersion.`,
            'Keep minSupportedApiVersion <= apiVersion for each declared capability domain.',
          ),
        );
      }
    }
  }

  if (expectedKind === 'fit-pack' || expectedKind === 'graph-adapter') {
    const expectedTargetDomain = expectedKind;
    if (typeof block.targetDomain !== 'string' || block.targetDomain !== expectedTargetDomain) {
      violations.push(
        violation(
          filePath,
          1,
          'capability-pack-target-domain-missing',
          `${rel}: ${pkg.name} must declare opensipTools.targetDomain='${expectedTargetDomain}'.`,
          'Contribution packages declare their target domain for epoch compatibility (ADR-0074).',
        ),
      );
    }
    if (typeof block.targetDomainApiVersion !== 'number') {
      violations.push(
        violation(
          filePath,
          1,
          'capability-pack-target-epoch-missing',
          `${rel}: ${pkg.name} must declare numeric opensipTools.targetDomainApiVersion.`,
          'Contribution packages declare the domain API epoch they target (ADR-0074).',
        ),
      );
    }
  }

  return violations;
}

async function analyzeToolManifestContract(files) {
  const violations = [];
  for (const filePath of files.paths) {
    if (relPath(filePath).endsWith('/package.json') || relPath(filePath) === 'package.json') {
      try {
        const pkg = JSON.parse(await files.read(filePath));
        violations.push(...analyzePackageManifest(pkg, filePath));
      } catch {
        // Malformed JSON belongs to the config parser / package-json checks.
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ADR-0023: capability domains are manifest data, not inline host literals.
// ---------------------------------------------------------------------------

const HARDCODED_CAPABILITY_DOMAIN_RE = /\b[A-Za-z_$][\w$]*\.registerDomain\s*\(\s*\{/g;

function analyzeCapabilityByManifest(content, filePath) {
  const rel = relPath(filePath);
  if (isTestOrFixture(rel)) return [];
  if (!/^packages\/(?:core|cli)\/src\//.test(rel)) return [];
  const violations = [];
  for (const match of content.matchAll(HARDCODED_CAPABILITY_DOMAIN_RE)) {
    violations.push(
      violation(
        filePath,
        lineOf(content, match.index ?? 0),
        'hardcoded-capability-domain',
        'Capability domains must be registered from tool manifests, not inline host literals (ADR-0023).',
        'Declare the domain under package.json#opensipTools.capabilities and route it through registerCapabilityDomainsFromManifest.',
      ),
    );
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ADR-0021 / command plane: tools expose CommandSpec, not raw Commander hooks.
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTOR_FILES = new Set(
  bundledToolPackageSegments.map((segment) => `packages/${segment}/engine/src/tool.ts`),
);

function analyzeCommandSurfaceParity(content, filePath) {
  const rel = relPath(filePath);
  if (isTestOrFixture(rel)) return [];
  const violations = [];
  if (TOOL_ENGINE_PATH.test(rel) && /\bprogram\.command\s*\(/.test(content)) {
    violations.push(
      violation(
        filePath,
        lineOfNeedle(content, 'program.command'),
        'tool-raw-commander-command',
        'Tool packages must not mount raw Commander commands; the host mounts CommandSpec objects (ADR-0021).',
        'Move option/argument declarations into defineCommand(...) and expose the spec through the tool descriptor.',
      ),
    );
  }
  if (TOOL_DESCRIPTOR_FILES.has(rel)) {
    if (!/\bcommandSpecs\s*:/.test(content)) {
      violations.push(
        violation(
          filePath,
          1,
          'tool-command-specs-missing',
          'Tool descriptors must expose commandSpecs as the single command surface (ADR-0021).',
          'Assemble tool command specs in tool.ts and let the CLI host mount them through mountCommandSpec.',
        ),
      );
    }
    if (/^\s*register\s*:/.m.test(content)) {
      violations.push(
        violation(
          filePath,
          lineOfNeedle(content, 'register:'),
          'tool-register-hook-returned',
          'The deprecated Tool.register command hook must not return (ADR-0021).',
          'Use commandSpecs; tool registrars are only for capability contributions, not Commander wiring.',
        ),
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ADR-0009 / ADR-0013: public barrels stay curated; internals move to /internal.
// ---------------------------------------------------------------------------

const PUBLIC_BARREL_FORBIDDEN_EXPORTS = {
  'packages/fitness/engine/src/index.ts': [
    'FitBaselineRepo',
    'RecipeService',
    'ExecutionContext',
    'CheckConfig',
    'FitnessRecipe',
    'RecipeCheckResult',
    'executeFit',
  ],
  'packages/graph/engine/src/index.ts': [
    'runGraph',
    'executeGraph',
    'CatalogRepo',
    'GraphConfig',
    'GRAPH_STAGES',
    'MemoryPressureError',
    'ShardBuildResult',
  ],
  'packages/simulation/engine/src/index.ts': ['executeSim', 'persistSimSession'],
};

function analyzePublicApiSurface(content, filePath) {
  const rel = relPath(filePath);
  const forbidden = PUBLIC_BARREL_FORBIDDEN_EXPORTS[rel];
  if (forbidden === undefined) return [];

  const violations = [];
  for (const symbol of forbidden) {
    const regex = new RegExp(String.raw`\bexport\b[\s\S]{0,240}\b${symbol}\b`);
    const match = regex.exec(content);
    if (match !== null) {
      violations.push(
        violation(
          filePath,
          lineOf(content, match.index),
          'public-barrel-internal-export',
          `Public barrel must not export internal symbol '${symbol}' (ADR-0009/0013).`,
          'Move engine-only and cross-package-test-only symbols to the package ./internal export, or add the symbol through an explicit public API review.',
        ),
      );
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '974e1f80-08c6-4a06-864c-9d56bae24979',
    slug: 'dogfood-no-bootstrap-tool-import',
    description:
      'CLI/core bootstrap must load tools/check packs by manifest and dynamic import, not static runtime imports (ADR-0009/0027/0029)',
    scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: analyzeNoBootstrapToolImport,
  }),
  defineCheck({
    id: 'fb02c22b-7ae5-4f8a-abe6-35b8a12f1874',
    slug: 'dogfood-tool-manifest-contract',
    description:
      'first-party tools, fit packs, and graph adapters must declare the expected opensipTools manifest marker',
    scope: { languages: ['typescript'], concerns: ['config'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['json'],
    contentFilter: 'raw',
    analyzeAll: analyzeToolManifestContract,
  }),
  defineCheck({
    id: '37383417-c4b6-45f0-bea6-8f427d309bd1',
    slug: 'dogfood-capability-by-manifest',
    description:
      'capability domains must be declared by tool manifests rather than inline host registerDomain literals (ADR-0023)',
    scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: analyzeCapabilityByManifest,
  }),
  defineCheck({
    id: '5cf0e867-f3aa-4e98-b3c2-810801edbd86',
    slug: 'dogfood-command-surface-parity',
    description:
      'tool packages expose declarative commandSpecs and never mount raw Commander commands (ADR-0021)',
    scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: analyzeCommandSurfaceParity,
  }),
  defineCheck({
    id: '69a62dfe-9385-4415-8e18-394444ca65bb',
    slug: 'dogfood-public-api-surface',
    description:
      'public package barrels must not re-export known engine internals; use ./internal for cross-package tests (ADR-0009/0013)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts'],
    contentFilter: 'strip-strings-and-comments',
    analyze: analyzePublicApiSurface,
  }),
];
