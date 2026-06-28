/**
 * Tier-2 worker E2E (ADR-0090 D6 Tier 2) — install / discover / dispatch the
 * osv-scanner adapter over a REAL forked worker, end-to-end against the BUILT CLI.
 *
 * Unlike the in-process Tier-1 suites, this proves the FULL installed-tool path:
 *   - the osv-scanner package is presented as a genuinely INSTALLED npm tool in a
 *     throwaway project (symlinked into its `node_modules` so the worker resolves
 *     the adapter's workspace deps from the monorepo via realpath);
 *   - `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` trusts it (installed tools are
 *     deny-by-default);
 *   - a FAKE `osv-scanner` binary on PATH makes the run deterministic (it copies
 *     the committed golden to `--output` and exits 1, like real osv-scanner on
 *     findings). The worker fork curates its env to an allow-list, so the golden
 *     path is forwarded via the documented `OPENSIP_CLI_TOOL_ENV_PASSTHROUGH`.
 *
 * `opensip osv` forks a worker that re-discovers + imports the real runtime and
 * runs the scan loop; this suite asserts the worker→host result + the host-side
 * effects: normalized signals match the golden, the raw artifact lands at
 * `.runtime/artifacts/osv-scanner/<runId>/osv.json` with mode 0600, the `--json`
 * envelope is well-formed, the session row persists with provenance, native
 * severity + provenance are preserved, and the full gate ratchet (gate-save →
 * clean compare → net-new vuln surfaces) works.
 *
 * Requires `pnpm build` first (the CLI dist + the osv-scanner dist). Missing builds
 * FAIL loudly (no silent skip).
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// .../packages/tool-osv-scanner/src/__tests__ → repo root is four levels up.
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const CLI_DIST = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
const OSV_PKG_DIR = join(REPO_ROOT, 'packages', 'tool-osv-scanner');
const FIXTURES = join(OSV_PKG_DIR, '__fixtures__');
const GOLDEN_PATH = join(FIXTURES, 'osv-golden.json');

const OSV_SCANNER_STABLE_ID = 'd25a4471-3289-4660-b5ab-63830072d0e1';

const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, 'expected-signals.json'), 'utf8')) as {
  ruleId: string;
  severity: string;
  message: string;
  file: string;
}[];

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

let projectDir: string;
let binDir: string;
let baseEnv: Record<string, string>;

/** Run the built CLI as a child process, capturing stdout/stderr + exit code. */
function runCli(args: string[], extraEnv: Record<string, string> = {}, cwd = projectDir): CliRun {
  try {
    const stdout = execFileSync('node', [CLI_DIST, ...args], {
      cwd,
      env: { ...process.env, ...baseEnv, ...extraEnv },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

/** Scaffold a throwaway opensip-cli project that resolves the installed osv-scanner tool. */
function makeOsvProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-osv-gate-'));
  writeFileSync(join(dir, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
  const scopeDir = join(dir, 'node_modules', '@opensip-cli');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(OSV_PKG_DIR, join(scopeDir, 'tool-osv-scanner'), 'dir');
  return dir;
}

/** Read the `--json` outcome wrapper (`{ kind, status, exitCode, envelope?, data? }`) from a run. */
function outcomeJson(run: CliRun): Record<string, unknown> {
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` first`);
  }
  if (!existsSync(join(OSV_PKG_DIR, 'dist', 'index.js'))) {
    throw new Error('built tool-osv-scanner dist not found — run `pnpm build` first');
  }

  projectDir = mkdtempSync(join(tmpdir(), 'opensip-osv-e2e-'));
  // Project marker so the worker's `scope: 'project'` bootstrap resolves a project.
  writeFileSync(
    join(projectDir, 'opensip-cli.config.yml'),
    'schemaVersion: 1\ntargets: {}\n',
    'utf8',
  );
  // Present the REAL osv-scanner package as an installed npm tool. A SYMLINK (not a
  // copy) so the worker resolves the adapter's `@opensip-cli/*` workspace deps from
  // the monorepo via realpath — a copy would orphan them.
  const scopeDir = join(projectDir, 'node_modules', '@opensip-cli');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(OSV_PKG_DIR, join(scopeDir, 'tool-osv-scanner'), 'dir');

  // A FAKE osv-scanner on PATH for determinism (copies the golden to --output,
  // exits 1). PATH is auto-forwarded into the worker fork's curated env.
  binDir = mkdtempSync(join(tmpdir(), 'opensip-osv-bin-'));
  cpSync(join(FIXTURES, 'fake-osv-scanner'), join(binDir, 'osv-scanner'));
  execFileSync('chmod', ['+x', join(binDir, 'osv-scanner')]);

  baseEnv = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    // The committed fake binary reads the golden path from here; forward it through
    // the worker fork's env allow-list via the documented passthrough.
    FAKE_OSV_GOLDEN: GOLDEN_PATH,
    OPENSIP_CLI_TOOL_ENV_PASSTHROUGH: 'FAKE_OSV_GOLDEN',
    // Installed tools are deny-by-default — trust the osv-scanner id (the admission
    // check keys on `opensipTools.id`; the UUID is included to match the ADR-0048
    // stable id convention).
    OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: `${OSV_SCANNER_STABLE_ID} osv-scanner`,
  };
});

afterAll(() => {
  if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
  if (binDir !== undefined) rmSync(binDir, { recursive: true, force: true });
});

describe('osv-scanner worker E2E — opensip osv (real forked worker)', () => {
  let scan: CliRun;
  let envelope: {
    tool: string;
    runId: string;
    verdict: { passed: boolean };
    signals: {
      ruleId: string;
      severity: string;
      message: string;
      filePath: string;
      fingerprint?: string;
      metadata: Record<string, unknown>;
    }[];
  };

  beforeAll(() => {
    // Invoke via the `osv` ALIAS to prove the aliased primary mounts + dispatches.
    scan = runCli(['osv', '--json']);
    const outcome = outcomeJson(scan);
    envelope = outcome.envelope as typeof envelope;
  });

  it('forks a worker and emits a well-formed signal envelope for osv-scanner', () => {
    expect(envelope.tool).toBe('osv-scanner');
    expect(envelope.runId).toMatch(/^RUN_/);
    // A high-severity vuln ⇒ the run FAILS; the gate exit is non-zero (findings).
    expect(envelope.verdict.passed).toBe(false);
    expect(scan.status).toBe(1);
  });

  it('normalizes the worker scan output to the golden signal shapes', () => {
    const shapes = envelope.signals.map((s) => ({
      ruleId: s.ruleId,
      severity: s.severity,
      message: s.message,
      file: s.filePath,
    }));
    expect(shapes).toEqual(EXPECTED);
  });

  it('stamps message-hash fingerprints + provenance + native severity worker-side', () => {
    for (const s of envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      const provenance = s.metadata.provenance as { tool: string; adapterPackage: string };
      expect(provenance.tool).toBe('osv-scanner');
      expect(provenance.adapterPackage).toBe('@opensip-cli/tool-osv-scanner');
    }
    // Native scanner severity preserved beside the mapped four-bucket severity.
    const [high, moderate] = envelope.signals;
    expect(high?.metadata.nativeSeverity).toBe('HIGH');
    expect(high?.metadata.cvss).toBe('7.5');
    expect(moderate?.metadata.nativeSeverity).toBe('MODERATE');
  });

  it('lands the raw artifact under .runtime/artifacts/osv-scanner/<runId>/osv.json with mode 0600', () => {
    const runDir = join(projectDir, 'opensip-cli', '.runtime', 'artifacts', 'osv-scanner');
    expect(existsSync(runDir)).toBe(true);
    const runs = readdirSync(runDir);
    expect(runs.length).toBeGreaterThan(0);
    const artifact = join(runDir, runs[0], 'osv.json');
    expect(existsSync(artifact)).toBe(true);
    // Owner-only read/write (0600) — the artifact carries the raw scanner output.
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
    // The persisted artifact is the byte-preserved golden (two vulnerabilities).
    const doc = JSON.parse(readFileSync(artifact, 'utf8')) as {
      results: { packages: unknown[] }[];
    };
    expect(doc.results[0].packages).toHaveLength(2);
  });

  it('persists a session row with the osv-scanner tool + provenance payload', () => {
    const list = runCli(['sessions', 'list', '--json']);
    expect(list.status).toBe(0);
    const outcome = outcomeJson(list);
    const data = outcome.data as { sessions?: Record<string, unknown>[] } | undefined;
    const sessions = data?.sessions ?? [];
    const osvRow = sessions.find((s) => s.tool === 'osv-scanner');
    expect(osvRow).toBeDefined();
    expect(osvRow?.passed).toBe(false);
    const payload = osvRow?.payload as { binary?: { path?: string }; findings?: number };
    expect(payload?.binary?.path).toContain('osv-scanner');
    expect(payload?.findings).toBe(2);
  });
});

describe('osv-scanner worker E2E — doctor / version diagnostics', () => {
  it('doctor --json reports a ready, resolved binary (exit 0)', () => {
    const run = runCli(['osv-scanner', 'doctor', '--json']);
    expect(run.status).toBe(0);
    const report = outcomeJson(run).data as {
      tool: string;
      ready: boolean;
      binary: { found: boolean };
      version: { detected?: string; status: string };
    };
    expect(report.tool).toBe('osv-scanner');
    expect(report.ready).toBe(true);
    expect(report.binary.found).toBe(true);
    expect(report.version.detected).toBe('1.9.1');
    expect(report.version.status).toBe('ok');
  });

  it('doctor reports NOT ready (exit 2) when the resolved binary is missing', () => {
    // Pin the binary to a non-existent absolute path via the env layer (which beats
    // PATH and hard-misses) so resolution fails WITHOUT breaking the toolchain/worker
    // fork. Forward the pin into the worker (doctor probes worker-side) via the
    // documented passthrough.
    const run = runCli(['osv-scanner', 'doctor', '--json'], {
      OPENSIP_OSV_SCANNER_BIN: '/nonexistent/path/to/osv-scanner',
      OPENSIP_CLI_TOOL_ENV_PASSTHROUGH: 'FAKE_OSV_GOLDEN OPENSIP_OSV_SCANNER_BIN',
    });
    expect(run.status).toBe(2);
    const report = outcomeJson(run).data as { ready: boolean; binary: { found: boolean } };
    expect(report.ready).toBe(false);
    expect(report.binary.found).toBe(false);
  });

  it('version --json prints the resolved osv-scanner binary version', () => {
    const run = runCli(['osv-scanner', 'version', '--json']);
    expect(run.status).toBe(0);
    const report = outcomeJson(run).data as { found: boolean; version?: string };
    expect(report.found).toBe(true);
    expect(report.version).toBe('1.9.1');
  });
});

describe('osv-scanner worker E2E — installed tools are deny-by-default', () => {
  it('without the trust allowlist, `opensip osv` is not admitted', () => {
    const run = runCli(['osv', '--json'], { OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: '' });
    // Deny-by-default: the command never mounts (unknown command / not found), so
    // the scan does NOT run.
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`.toLowerCase()).toMatch(/unknown command|not found|osv/);
  });
});

/**
 * §4.12 ratchet acceptance — the FULL baseline/gate loop over a REAL forked worker.
 * The substrate wires `--gate-save` / `--gate-compare` once (ADR-0036), so the
 * osv-scanner adapter inherits it. This proves: capture a baseline → an unchanged
 * re-scan is clean (exit 0) → a NET-NEW vulnerability surfaces and fails (exit ≠ 0).
 *
 * Runs in its OWN throwaway project so the baseline + sessions are isolated from the
 * scan suites above. The fake binary copies `FAKE_OSV_GOLDEN` to `--output`;
 * pointing it at an AUGMENTED golden (the two originals + one new vuln in a new
 * package) is how the "regression" run injects a net-new finding.
 */
describe('osv-scanner worker E2E — full gate ratchet (§4.12)', () => {
  let gateProject: string;
  let augmentedGolden: string;
  let save: CliRun;
  let compareClean: CliRun;
  let compareRegressed: CliRun;

  beforeAll(() => {
    gateProject = makeOsvProject();

    // The augmented golden = the committed two findings + one NET-NEW vuln in a new
    // package (a distinct ruleId/message ⇒ a distinct message-hash fingerprint ⇒ the
    // ratchet sees it as net-new, not unchanged).
    const original = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as {
      results: { packages: unknown[] }[];
    };
    original.results[0].packages.push({
      package: { name: 'axios', version: '0.21.0', ecosystem: 'npm' },
      vulnerabilities: [
        {
          id: 'GHSA-NEWVULN-FAKE-0001',
          summary: 'Server-Side Request Forgery in axios',
          aliases: ['CVE-2024-99999'],
          database_specific: { severity: 'HIGH' },
        },
      ],
      groups: [{ ids: ['GHSA-NEWVULN-FAKE-0001'], max_severity: '8.6' }],
    });
    augmentedGolden = join(gateProject, 'augmented-golden.json');
    writeFileSync(augmentedGolden, JSON.stringify(original), 'utf8');

    // 1) Capture the baseline (two findings). The findings gate (ADR-0020) makes
    //    gate-save itself exit 1 — it records the baseline AND honours the verdict.
    save = runCli(['osv', '--gate-save'], {}, gateProject);
    // 2) Re-scan the SAME golden and compare → no net-new ⇒ clean (exit 0).
    compareClean = runCli(['osv', '--gate-compare'], {}, gateProject);
    // 3) Compare against the augmented golden → one net-new finding ⇒ degraded.
    compareRegressed = runCli(
      ['osv', '--gate-compare'],
      { FAKE_OSV_GOLDEN: augmentedGolden },
      gateProject,
    );
  });

  afterAll(() => {
    if (gateProject !== undefined) rmSync(gateProject, { recursive: true, force: true });
  });

  it('--gate-save records the baseline and persists a session', () => {
    // The findings gate makes gate-save exit 1 (a high-severity vuln present), but
    // the baseline IS written — proven by the clean compare below.
    expect(save.status).toBe(1);
    const list = runCli(['sessions', 'list', '--json'], {}, gateProject);
    const data = outcomeJson(list).data as { sessions?: Record<string, unknown>[] };
    const osvRows = (data.sessions ?? []).filter((s) => s.tool === 'osv-scanner');
    expect(osvRows.length).toBeGreaterThanOrEqual(1);
  });

  it('--gate-compare on the SAME scan is a clean no-op (exit 0, no regression)', () => {
    // Pre-existing findings recorded in the baseline are NOT a regression — only
    // net-new findings fail the ratchet. The clean exit also proves gate-save wrote
    // the baseline (a missing baseline would throw ConfigurationError → exit 2).
    expect(compareRegressed).toBeDefined();
    expect(compareClean.status).toBe(0);
    expect(`${compareClean.stdout}${compareClean.stderr}`).toMatch(/STABLE|no change/i);
  });

  it('--gate-compare surfaces a NET-NEW vulnerability and exits non-zero (degraded)', () => {
    expect(compareRegressed.status).not.toBe(0);
    const out = `${compareRegressed.stdout}${compareRegressed.stderr}`;
    // The net-new advisory is named in the diff; the verdict footer says DEGRADED.
    expect(out).toContain('GHSA-NEWVULN-FAKE-0001');
    expect(out).toMatch(/DEGRADED|Added/i);
  });
});
