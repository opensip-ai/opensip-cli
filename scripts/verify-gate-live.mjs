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
// docs/plans/ready/depcruise-gate-activation/phase-7-verification.md.
//
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';

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

// Run a set of inject-revert probes: write each probe file, cruise it, assert
// the expected rule appears in the report, then remove the file in a finally so
// the working tree is never left dirty even if depcruise throws.
function verifyProbesFire(probes, label) {
  for (const probe of probes) {
    try {
      writeFileSync(probe.file, probe.source, 'utf8');
      const report = depcruiseReport(probe.file);
      if (!report.includes(probe.rule)) {
        console.error(
          `verify-gate-live: FAIL — probe import in ${probe.file} did NOT trip ` +
            `'${probe.rule}'. The ${label} is INERT.\n` +
            `depcruise report:\n${report}`,
        );
        process.exit(1);
      }
    } finally {
      rmSync(probe.file, { force: true });
    }
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
}

main();
