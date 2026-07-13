#!/usr/bin/env node
//
// verify-gate-live — guard against the dependency-cruiser architecture gate
// silently going INERT.
//
// Background: every cross-package layer rule in .config/dependency-cruiser.cjs
// matches RESOLVED file paths (e.g. ^packages/fitness/engine/). Those rules
// can only fire if @opensip-cli imports actually resolve into a package's
// src tree and appear as edges in the cruise graph. That resolution depends
// on .config/tsconfig.depcruise.json (the `paths` map) being wired into
// options.tsConfig.fileName. If that wiring breaks — a tsconfig rename, a
// resolver-option change, a dropped paths entry — cross-package edges vanish
// from the graph, every cross-package rule matches nothing, and
// `pnpm depcruise` goes GREEN while enforcing NOTHING. That is exactly the
// bug this gate-activation effort fixed (the gate had been inert since
// inception).
//
// A green depcruise run looks identical whether the rules work or match
// nothing, so depcruise alone cannot detect its own inertness. This script
// closes that gap WITHOUT mutating any source file (CI-safe, working-tree-
// safe): it cruises the workspace and asserts the graph still contains
// resolved cross-package edges. If the resolver breaks, this fails loudly.
//
// Wired into `pnpm lint` so CI catches re-inerting. Rule-FIRING (as opposed
// to edge-resolution) is verified via inject-revert probes documented in
// a local implementation plan
//
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { readWorkspacePackageManifests } = require('./lib/workspace-package-manifests.cjs');
const { readWorkspaceExportMap } = require('./lib/workspace-export-map.cjs');
const {
  readProductionToolPackageInventory,
} = require('./lib/workspace-tool-package-inventory.cjs');

// Well below the ~390 cross-package edges observed; guards against a
// partial break where only a few stragglers resolve.
const MIN_CROSS_PACKAGE_EDGES = 50;

// ADR-0011 tool-output gate liveness. Edge-resolution (above) proves the
// resolver works; it does NOT prove a specific rule still FIRES. The three
// rules added in Phase 8 (tool-engines-no-output-{formatters,sinks,barrel})
// guard "tools emit, never render/deliver". A gate that cannot fail is not a
// gate — so we inject a temporary forbidden import into a tool engine, run
// depcruise scoped to JUST that probe file, and assert the expected rule
// reports it. Every probe is removed in a finally, so the working tree is
// never left dirty even if depcruise throws (it's CI-safe + local-safe).
const PROBE_DIR = 'packages/graph/engine/src';
const TOOL_OUTPUT_PROBES = [
  {
    // Deep subpath import → resolves straight into output/src/format/.
    file: `${PROBE_DIR}/__gate_probe_formatter__.ts`,
    source:
      "import { formatSignalSarif } from '../../../output/src/format/signal-sarif.js';\n" +
      'export const _gateProbe = formatSignalSarif;\n',
    rule: 'tool-engines-no-output-formatters',
  },
  {
    // Deep subpath import → resolves straight into output/src/sink/.
    file: `${PROBE_DIR}/__gate_probe_sink__.ts`,
    source:
      "import { createCloudSignalSink } from '../../../output/src/sink/cloud-signal-sink.js';\n" +
      'export const _gateProbe = createCloudSignalSink;\n',
    rule: 'tool-engines-no-output-sinks',
  },
  {
    // Barrel import → resolves to output/src/index.ts (the realistic
    // regression vector the granular rules can't see).
    file: `${PROBE_DIR}/__gate_probe_barrel__.ts`,
    source:
      "import { formatSignalSarif } from '@opensip-cli/output';\n" +
      'export const _gateProbe = formatSignalSarif;\n',
    rule: 'tool-engines-no-output-barrel',
  },
];

// ADR-0004 / ADR-0010 external-package gate liveness. Same rationale as the
// tool-output probes above, but these two rules are special: their `to` targets
// an EXTERNAL npm family (the OTel SDK; web-tree-sitter), not a workspace path.
// They can only fire because .config/dependency-cruiser.cjs surfaces those two
// families into the cruise graph via a UNION includeOnly. If that union is
// reverted to a bare '^packages/' (the natural-looking "cleanup"), the npm edge
// is dropped before rules run and BOTH guards go silently inert — depcruise
// stays green while enforcing nothing. These probes inject a forbidden external
// import from a non-exempt package and assert the rule still reports it.
const EXTERNAL_GATE_PROBES = [
  {
    // ADR-0004: OTel SDK family may live only in packages/cli. Inject from a
    // tool engine (a non-cli package) and expect the rule to fire.
    file: `${PROBE_DIR}/__gate_probe_otel_sdk__.ts`,
    source: "import '@opentelemetry/sdk-trace-node';\n" + 'export const _gateProbe = 1;\n',
    rule: 'otel-sdk-only-in-cli',
  },
  {
    // ADR-0010: web-tree-sitter may be imported only by the tree-sitter
    // substrate and the lang-* adapters. Inject from a non-lang package and
    // expect the rule to fire.
    file: 'packages/fitness/engine/src/__gate_probe_tree_sitter__.ts',
    source: "import { Parser } from 'web-tree-sitter';\n" + 'export const _gateProbe = Parser;\n',
    rule: 'tree-sitter-parser-only-in-lang-packs',
  },
];

// ADR-0064 clone-detection / yagni graph-independence gate liveness. These
// probes prove the shared clone substrate remains a leaf and yagni cannot regain
// a graph engine/adapter production edge while still allowing test-only parity
// fixtures to import the graph TypeScript adapter.

// ADR-0144 format package leaf gate liveness.
const ADR_0144_PROBES = [
  {
    file: 'packages/format/src/__gate_probe_contracts__.ts',
    source:
      "import { BUILTIN_DEFAULT_RECIPE } from '@opensip-cli/contracts';\n" +
      'export const _gateProbe = BUILTIN_DEFAULT_RECIPE;\n',
    rule: 'format-imports-nothing',
  },
];

const ADR_0064_PROBES = [
  {
    file: 'packages/clone-detection/src/__gate_probe_contracts__.ts',
    source:
      "import { BUILTIN_DEFAULT_RECIPE } from '@opensip-cli/contracts';\n" +
      'export const _gateProbe = BUILTIN_DEFAULT_RECIPE;\n',
    rule: 'clone-detection-imports-nothing',
  },
  {
    file: 'packages/yagni/engine/src/__gate_probe_graph_engine__.ts',
    source:
      "import { graphTool } from '@opensip-cli/graph';\n" +
      'export const _gateProbe = graphTool;\n',
    rule: 'yagni-no-graph-engine',
  },
  {
    file: 'packages/yagni/engine/src/__gate_probe_graph_adapter__.ts',
    source:
      "import { typescriptGraphAdapter } from '@opensip-cli/graph-typescript';\n" +
      'export const _gateProbe = typescriptGraphAdapter;\n',
    rule: 'yagni-no-graph-adapter-packs',
  },
];

// Modular-boundary hardening: these probes prove the manifest-derived Tool
// allowlists and public/internal subpath policy actually fire.
const MODULAR_BOUNDARY_FAILURE_PROBES = [
  {
    file: 'packages/fitness/engine/src/__gate_probe_simulation_peer__.ts',
    source:
      "import { simulationTool } from '@opensip-cli/simulation';\n" +
      'export const _gateProbe = simulationTool;\n',
    rule: 'tool-package-fitness-imports-allowlist',
  },
  {
    file: 'packages/fitness/engine/src/__gate_probe_datastore_internal__.ts',
    source:
      "import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';\n" +
      'export const _gateProbe = requireDrizzleHandle;\n',
    rule: 'no-cross-package-internal',
  },
  {
    file: 'packages/mcp/src/__gate_probe_graph_internal__.ts',
    source:
      "import { CatalogRepo } from '@opensip-cli/graph/internal';\n" +
      'export const _gateProbe = CatalogRepo;\n',
    rule: 'mcp-graph-internal-scope',
  },
  {
    // CLI composition root may not statically import a manifest Tool source.
    file: 'packages/cli/src/__gate_probe_static_tool__.ts',
    source:
      "import { graphTool } from '@opensip-cli/graph';\nexport const _gateProbe = graphTool;\n",
    rule: 'cli-no-static-tool-package-import',
  },
  {
    // Production siblings may not import simulation/internal (test-only subpath,
    // ADR-0009) — enforced by the generic internal rule (no owner exception).
    file: 'packages/fitness/engine/src/__gate_probe_sim_internal__.ts',
    source:
      "import { createScenarioRegistry } from '@opensip-cli/simulation/internal';\n" +
      'export const _gateProbe = createScenarioRegistry;\n',
    rule: 'no-cross-package-internal',
  },
  {
    // MCP may resolve the graph ROOT barrel only from the adapter registrar.
    file: 'packages/mcp/src/__gate_probe_graph_root__.ts',
    source:
      "import { currentAdapterRegistry } from '@opensip-cli/graph';\n" +
      'export const _gateProbe = currentAdapterRegistry;\n',
    rule: 'mcp-graph-root-registrar-only',
  },
];

const MODULAR_BOUNDARY_RESOLUTION_PROBES = [
  {
    file: 'packages/languages/lang-typescript/src/__gate_probe_core_parse_cache__.ts',
    source:
      "import { clearParseCache } from '@opensip-cli/core/languages/parse-cache.js';\n" +
      'export const _gateProbe = clearParseCache;\n',
    module: '@opensip-cli/core/languages/parse-cache.js',
    resolved: 'packages/core/src/languages/parse-cache.ts',
  },
  {
    file: 'packages/session-store/src/__gate_probe_datastore_internal__.ts',
    source:
      "import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';\n" +
      'export const _gateProbe = requireDrizzleHandle;\n',
    module: '@opensip-cli/datastore/internal',
    resolved: 'packages/datastore/src/internal.ts',
  },
  {
    file: 'packages/mcp/src/__gate_probe_graph_read__.ts',
    source:
      "import { readCatalogIdentity } from '@opensip-cli/graph/read';\n" +
      'export const _gateProbe = readCatalogIdentity;\n',
    module: '@opensip-cli/graph/read',
    resolved: 'packages/graph/engine/src/read/index.ts',
  },
];

function depcruiseReport(target) {
  // err-long emits the rule name + offending edge; non-zero exit on
  // violations is expected and not an error for the probe.
  try {
    return execFileSync(
      'npx',
      [
        'depcruise',
        '--config',
        '.config/dependency-cruiser.cjs',
        '--no-progress',
        '--output-type',
        'err',
        target,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    // depcruise exits non-zero when it finds violations; the report we want
    // is on stdout, which execFileSync attaches to the thrown error.
    return (error.stdout || '') + (error.stderr || '');
  }
}

function depcruiseJson(target) {
  try {
    const output = execFileSync(
      'npx',
      [
        'depcruise',
        '--config',
        '.config/dependency-cruiser.cjs',
        '--no-progress',
        '--output-type',
        'json',
        target,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(output);
  } catch (error) {
    const report = (error.stdout || '') + (error.stderr || '');
    throw new Error(`depcruise resolution probe failed for ${target}:\n${report}`, {
      cause: error,
    });
  }
}

// Run a set of inject-revert probes: write each probe file, cruise it, assert
// the expected rule appears in the report, then remove the file in a finally so
// the working tree is never left dirty even if depcruise throws.
function verifyProbesFire(probes, label) {
  // Capture failure and exit AFTER the loop so each probe's `finally` cleanup
  // actually runs — `process.exit()` inside the `try` would skip it and leak the
  // probe file into the repo tree.
  let failure;
  for (const probe of probes) {
    try {
      writeFileSync(probe.file, probe.source, 'utf8');
      const report = depcruiseReport(probe.file);
      if (!report.includes(probe.rule)) {
        failure =
          `verify-gate-live: FAIL — probe import in ${probe.file} did NOT trip ` +
          `'${probe.rule}'. The ${label} is INERT.\n` +
          `depcruise report:\n${report}`;
      }
    } finally {
      rmSync(probe.file, { force: true });
    }
    if (failure) break;
  }
  if (failure) {
    console.error(failure);
    process.exit(1);
  }
}

function verifyToolOutputGatesFire() {
  verifyProbesFire(TOOL_OUTPUT_PROBES, 'ADR-0011 tool-output gate');
  console.log(
    `verify-gate-live: OK — all ${TOOL_OUTPUT_PROBES.length} tool-output gates ` +
      'fired on a probe (tools-emit-never-render is live).',
  );
}

function verifyExternalGatesFire() {
  verifyProbesFire(EXTERNAL_GATE_PROBES, 'ADR-0004/ADR-0010 external-package gate');
  console.log(
    `verify-gate-live: OK — all ${EXTERNAL_GATE_PROBES.length} external-package gates ` +
      'fired on a probe (OTel-SDK-only-in-cli + tree-sitter-parser-only-in-lang-packs are live).',
  );
}

function verifyAdr0064GatesFire() {
  verifyProbesFire(ADR_0064_PROBES, 'ADR-0064 clone-detection/yagni graph-independence gate');
  console.log(
    `verify-gate-live: OK — all ${ADR_0064_PROBES.length} ADR-0064 gates ` +
      'fired on a probe (clone-detection leaf + yagni-no-graph are live).',
  );
  verifyProbesFire(ADR_0144_PROBES, 'ADR-0144 format package leaf gate');
  console.log(
    `verify-gate-live: OK — all ${ADR_0144_PROBES.length} ADR-0144 gates ` +
      'fired on a probe (format leaf is live).',
  );
}

function verifyModularBoundaryResolution() {
  let failure;
  for (const probe of MODULAR_BOUNDARY_RESOLUTION_PROBES) {
    try {
      writeFileSync(probe.file, probe.source, 'utf8');
      const graph = depcruiseJson(probe.file);
      const source = (graph.modules ?? []).find((candidate) => candidate.source === probe.file);
      const dependency = source?.dependencies?.find(
        (candidate) => candidate.module === probe.module,
      );
      if (dependency?.resolved !== probe.resolved) {
        failure =
          `verify-gate-live: FAIL — ${probe.module} resolved to ` +
          `${dependency?.resolved ?? '<missing>'}; expected ${probe.resolved}.`;
      }
    } finally {
      // Runs on break/normal completion — process.exit would skip it.
      rmSync(probe.file, { force: true });
    }
    if (failure) break;
  }
  if (failure) {
    console.error(failure);
    process.exit(1);
  }
  console.log(
    `verify-gate-live: OK — all ${MODULAR_BOUNDARY_RESOLUTION_PROBES.length} ` +
      'modular-boundary public/owner subpaths resolved to source.',
  );
}

function verifyArbitraryToolAllowlist() {
  const packageDir = 'packages/__gate_probe_oddity_tool__';
  const sourceFile = `${packageDir}/src/tool.ts`;
  let failure;
  try {
    mkdirSync(`${packageDir}/src`, { recursive: true });
    writeFileSync(
      `${packageDir}/package.json`,
      JSON.stringify({
        name: '@opensip-cli/unlisted-audit-tool',
        type: 'module',
        exports: { '.': './dist/tool.js' },
        opensipTools: { kind: 'tool' },
      }),
      'utf8',
    );
    writeFileSync(
      sourceFile,
      "import { graphTool } from '@opensip-cli/graph';\nexport const tool = graphTool;\n",
      'utf8',
    );
    const report = depcruiseReport(sourceFile);
    const expectedRule = 'tool-package-unlisted-audit-tool-imports-allowlist';
    if (!report.includes(expectedRule)) {
      failure =
        `verify-gate-live: FAIL — arbitrarily named manifest Tool did not trip ` +
        `${expectedRule}.\ndepcruise report:\n${report}`;
    }
  } finally {
    // MUST run before any exit — a leftover probe PACKAGE poisons every later
    // depcruise config load, so cleanup cannot be skipped by process.exit.
    rmSync(packageDir, { recursive: true, force: true });
  }
  if (failure) {
    console.error(failure);
    process.exit(1);
  }
  console.log(
    'verify-gate-live: OK — an arbitrarily named manifest Tool was automatically denied a peer import.',
  );
}

function verifyArbitraryFitPackAllowlist() {
  const packageDir = 'packages/__gate_probe_oddity_fitpack__';
  const sourceFile = `${packageDir}/src/check.ts`;
  let failure;
  try {
    mkdirSync(`${packageDir}/src`, { recursive: true });
    writeFileSync(
      `${packageDir}/package.json`,
      JSON.stringify({
        name: '@opensip-cli/unlisted-audit-fitpack',
        type: 'module',
        exports: { '.': './dist/index.js' },
        opensipTools: { kind: 'fit-pack' },
      }),
      'utf8',
    );
    // An illegal datastore import a permissive default would allow.
    writeFileSync(
      sourceFile,
      "import { DataStoreFactory } from '@opensip-cli/datastore';\nexport const factory = DataStoreFactory;\n",
      'utf8',
    );
    // A fit pack absent from FIT_PACK_ALLOWED_PACKAGES must fail closed at config
    // load (ADR-0151), not receive a permissive default — stricter than a rule firing.
    const report = depcruiseReport(sourceFile);
    if (!/no reviewed dependency allowlist|not a kind:fit-pack/u.test(report)) {
      failure =
        'verify-gate-live: FAIL — an arbitrarily named manifest fit pack did not fail closed at ' +
        `dependency-cruiser config load.\ndepcruise report:\n${report}`;
    }
  } finally {
    // MUST run before any exit — a leftover kind:fit-pack probe package throws at
    // every later depcruise config load (self-poisoning), so never skip cleanup.
    rmSync(packageDir, { recursive: true, force: true });
  }
  if (failure) {
    console.error(failure);
    process.exit(1);
  }
  console.log(
    'verify-gate-live: OK — an arbitrarily named manifest fit pack fails closed without a reviewed allowlist.',
  );
}

function verifyWorkspaceReaderGuards() {
  const root = mkdtempSync(join(tmpdir(), 'opensip-gate-workspace-'));
  const outside = mkdtempSync(join(tmpdir(), 'opensip-gate-outside-'));
  try {
    mkdirSync(join(root, 'packages'), { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n", 'utf8');
    writeFileSync(
      join(outside, 'package.json'),
      JSON.stringify({ name: '@opensip-cli/escape' }),
      'utf8',
    );
    symlinkSync(outside, join(root, 'packages', 'escape'));

    let symlinkRejected = false;
    try {
      readWorkspacePackageManifests(root);
    } catch (error) {
      symlinkRejected = /escapes repository root/u.test(String(error));
    }
    if (!symlinkRejected) {
      console.error('verify-gate-live: FAIL — workspace package symlink escape was accepted.');
      process.exit(1);
    }

    rmSync(join(root, 'packages', 'escape'), { recursive: true, force: true });
    const manifestEscapeDir = join(root, 'packages', 'manifest-escape');
    mkdirSync(manifestEscapeDir, { recursive: true });
    symlinkSync(join(outside, 'package.json'), join(manifestEscapeDir, 'package.json'));
    let manifestSymlinkRejected = false;
    try {
      readWorkspacePackageManifests(root);
    } catch (error) {
      manifestSymlinkRejected = /manifest escapes package root/u.test(String(error));
    }
    if (!manifestSymlinkRejected) {
      console.error('verify-gate-live: FAIL — workspace manifest-file escape was accepted.');
      process.exit(1);
    }

    rmSync(manifestEscapeDir, { recursive: true, force: true });
    const toolEscapeDir = join(root, 'packages', 'tool-escape');
    mkdirSync(toolEscapeDir, { recursive: true });
    writeFileSync(
      join(toolEscapeDir, 'package.json'),
      JSON.stringify({
        name: '@opensip-cli/tool-escape',
        opensipTools: { kind: 'tool' },
      }),
      'utf8',
    );
    mkdirSync(join(outside, 'src'), { recursive: true });
    writeFileSync(join(outside, 'src', 'tool.ts'), 'export {};\n', 'utf8');
    symlinkSync(join(outside, 'src'), join(toolEscapeDir, 'src'));
    let sourceSymlinkRejected = false;
    try {
      readProductionToolPackageInventory(root);
    } catch (error) {
      sourceSymlinkRejected = /source directory escapes package root/u.test(String(error));
    }
    if (!sourceSymlinkRejected) {
      console.error('verify-gate-live: FAIL — Tool source-directory escape was accepted.');
      process.exit(1);
    }

    rmSync(join(toolEscapeDir, 'src'), { recursive: true, force: true });
    mkdirSync(join(toolEscapeDir, 'src'), { recursive: true });
    writeFileSync(join(outside, 'tool.ts'), 'export {};\n', 'utf8');
    symlinkSync(join(outside, 'tool.ts'), join(toolEscapeDir, 'src', 'tool.ts'));
    let descriptorSymlinkRejected = false;
    try {
      readProductionToolPackageInventory(root);
    } catch (error) {
      descriptorSymlinkRejected = /descriptor escapes source root/u.test(String(error));
    }
    if (!descriptorSymlinkRejected) {
      console.error('verify-gate-live: FAIL — Tool descriptor-file escape was accepted.');
      process.exit(1);
    }

    rmSync(toolEscapeDir, { recursive: true, force: true });
    const packageDir = join(root, 'packages', 'bad-export');
    mkdirSync(join(packageDir, 'src'), { recursive: true });
    writeFileSync(join(packageDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@opensip-cli/bad-export',
        exports: { '.': './dist/../escape.js' },
      }),
      'utf8',
    );
    const { diagnostics } = readWorkspaceExportMap(root);
    if (!diagnostics.some((diagnostic) => /escapes package/u.test(diagnostic))) {
      console.error('verify-gate-live: FAIL — traversing workspace export target was accepted.');
      process.exit(1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
  console.log(
    'verify-gate-live: OK — workspace manifest/source symlink and export traversal guards rejected probes.',
  );
}

function verifyModularBoundaryGates() {
  verifyProbesFire(
    MODULAR_BOUNDARY_FAILURE_PROBES,
    'manifest-derived Tool and public/internal boundary gate',
  );
  verifyModularBoundaryResolution();
  verifyArbitraryToolAllowlist();
  verifyArbitraryFitPackAllowlist();
  verifyWorkspaceReaderGuards();
}

// Top-level package dir of a packages/... path. Two-segment packages
// (graph/engine, fitness/checks-x, languages/lang-x) key on three path
// parts; one-segment packages (core, cli, dashboard) on two.
function pkgOf(p) {
  if (!p || !p.startsWith('packages/')) return null;
  const parts = p.split('/');
  if (parts.length >= 3 && parts[2] !== 'src') return parts[0] + '/' + parts[1] + '/' + parts[2];
  return parts[0] + '/' + parts[1];
}

function main() {
  let json;
  try {
    const out = execFileSync(
      'npx',
      [
        'depcruise',
        '--config',
        '.config/dependency-cruiser.cjs',
        '--no-progress',
        '--output-type',
        'json',
        'packages',
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    json = JSON.parse(out);
  } catch (error) {
    console.error('verify-gate-live: failed to run/parse depcruise:', error.message);
    process.exit(2);
  }

  const modules = json.modules || [];
  let crossPackageEdges = 0;
  let sawWorkspaceImportResolved = false;

  for (const m of modules) {
    const fromPkg = pkgOf(m.source);
    for (const d of m.dependencies || []) {
      const resolved = d.resolved || '';
      const mod = d.module || '';
      const isWorkspace = mod.startsWith('@opensip-cli/');
      // Signature of a resolved workspace import: @opensip-cli specifier
      // AND resolved into a package src tree.
      if (isWorkspace && resolved.startsWith('packages/')) {
        sawWorkspaceImportResolved = true;
        const toPkg = pkgOf(resolved);
        if (fromPkg && toPkg && fromPkg !== toPkg) crossPackageEdges++;
      }
      // No workspace import should resolve into dist or node_modules — that
      // means the resolver fell back to package exports and the gate is
      // half-broken.
      if (isWorkspace && (resolved.includes('/dist/') || resolved.includes('node_modules'))) {
        console.error(
          'verify-gate-live: @opensip-cli import resolved to built output (gate would be inert): ' +
            m.source +
            ' -> ' +
            resolved,
        );
        process.exit(1);
      }
    }
  }

  if (!sawWorkspaceImportResolved) {
    console.error(
      'verify-gate-live: FAIL — no @opensip-cli import resolved to a package src tree. The dependency-cruiser resolver is broken; every cross-package layer rule is INERT. Check options.tsConfig.fileName -> .config/tsconfig.depcruise.json and its paths map.',
    );
    process.exit(1);
  }
  if (crossPackageEdges < MIN_CROSS_PACKAGE_EDGES) {
    console.error(
      'verify-gate-live: FAIL — only ' +
        crossPackageEdges +
        ' cross-package edges resolved (expected >= ' +
        MIN_CROSS_PACKAGE_EDGES +
        '). The resolver is likely partially broken; cross-package rules may be inert.',
    );
    process.exit(1);
  }

  console.log(
    'verify-gate-live: OK — ' +
      crossPackageEdges +
      ' cross-package edges resolved into package src trees; the architecture gate is live.',
  );

  // Beyond edge-resolution: prove the ADR-0011 tool-output rules still fire.
  verifyToolOutputGatesFire();

  // Prove the ADR-0004 (OTel SDK) and ADR-0010 (tree-sitter Parser) external-
  // package guards still fire — they go inert if includeOnly stops surfacing
  // those two npm families into the graph.
  verifyExternalGatesFire();

  // Prove the ADR-0064 shared clone-detection substrate rules still fire.
  verifyAdr0064GatesFire();

  // Prove export-map completeness, owner-only internals, public graph/read,
  // and manifest-derived Tool peer isolation are live rather than declarative.
  verifyModularBoundaryGates();
}

main();
