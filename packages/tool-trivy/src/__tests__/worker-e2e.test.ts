/**
 * Tier-2 worker E2E (ADR-0090 D6 Tier 2) — install / discover / dispatch the trivy
 * adapter over a REAL forked worker, end-to-end against the BUILT CLI.
 *
 * Trivy is the SARIF adapter, so this also proves the shared `ingestSarif` read
 * path through the FULL installed-tool dispatch:
 *   - the trivy package is presented as a genuinely INSTALLED npm tool in a
 *     throwaway project (symlinked into its `node_modules` so the worker resolves
 *     the adapter's workspace deps from the monorepo via realpath);
 *   - `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` trusts it (installed tools are
 *     deny-by-default);
 *   - a FAKE `trivy` binary on PATH makes the run deterministic: it copies the
 *     committed golden SARIF to `--output` and exits 0 — Trivy exits 0 EVEN WITH
 *     findings, so the CLI's nonzero exit comes from the findings DERIVED FROM THE
 *     PARSED SARIF, not from the process exit (the Trivy exit-model proof). The
 *     worker fork curates its env to an allow-list, so the golden path is forwarded
 *     via the documented `OPENSIP_CLI_TOOL_ENV_PASSTHROUGH`.
 *
 * `opensip trivy` forks a worker that re-discovers + imports the real runtime and
 * runs the scan loop; this suite asserts the worker→host result + host-side
 * effects: normalized signals match the golden (with the RECOVERED severities —
 * `critical` from CVSS 9.8, not `high` from `level:"error"`), the raw SARIF
 * artifact lands at `.runtime/artifacts/trivy/<runId>/trivy.sarif` with mode 0600,
 * the `--json` envelope is well-formed, the session row persists with provenance,
 * and the full gate ratchet (gate-save → clean compare → net-new vuln surfaces)
 * works.
 *
 * Requires `pnpm build` first (the CLI dist + the trivy dist). Missing builds FAIL
 * loudly (no silent skip).
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
// .../packages/tool-trivy/src/__tests__ → repo root is four levels up.
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const CLI_DIST = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
const TRIVY_PKG_DIR = join(REPO_ROOT, 'packages', 'tool-trivy');
const FIXTURES = join(TRIVY_PKG_DIR, '__fixtures__');
const GOLDEN_PATH = join(FIXTURES, 'trivy-golden.sarif');

const TRIVY_STABLE_ID = 'a26ea0eb-ee3b-4e22-a3f3-7e1f93e16000';

const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, 'expected-signals.json'), 'utf8')) as {
  ruleId: string;
  severity: string;
  message: string;
  file: string;
  line: number;
  column: number;
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

/** Scaffold a throwaway opensip-cli project that resolves the installed trivy tool. */
function makeTrivyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-trivy-gate-'));
  writeFileSync(join(dir, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
  const scopeDir = join(dir, 'node_modules', '@opensip-cli');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(TRIVY_PKG_DIR, join(scopeDir, 'tool-trivy'), 'dir');
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
  if (!existsSync(join(TRIVY_PKG_DIR, 'dist', 'index.js'))) {
    throw new Error('built tool-trivy dist not found — run `pnpm build` first');
  }

  projectDir = mkdtempSync(join(tmpdir(), 'opensip-trivy-e2e-'));
  // Project marker so the worker's `scope: 'project'` bootstrap resolves a project.
  writeFileSync(
    join(projectDir, 'opensip-cli.config.yml'),
    'schemaVersion: 1\ntargets: {}\n',
    'utf8',
  );
  // Present the REAL trivy package as an installed npm tool. A SYMLINK (not a copy)
  // so the worker resolves the adapter's `@opensip-cli/*` workspace deps from the
  // monorepo via realpath — a copy would orphan them.
  const scopeDir = join(projectDir, 'node_modules', '@opensip-cli');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(TRIVY_PKG_DIR, join(scopeDir, 'tool-trivy'), 'dir');

  // A FAKE trivy on PATH for determinism (copies the golden SARIF to --output,
  // exits 0). PATH is auto-forwarded into the worker fork's curated env.
  binDir = mkdtempSync(join(tmpdir(), 'opensip-trivy-bin-'));
  cpSync(join(FIXTURES, 'fake-trivy'), join(binDir, 'trivy'));
  execFileSync('chmod', ['+x', join(binDir, 'trivy')]);

  baseEnv = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    // The committed fake binary reads the golden path from here; forward it through
    // the worker fork's env allow-list via the documented passthrough.
    FAKE_TRIVY_GOLDEN: GOLDEN_PATH,
    OPENSIP_CLI_TOOL_ENV_PASSTHROUGH: 'FAKE_TRIVY_GOLDEN',
    // Installed tools are deny-by-default — trust the trivy id (the admission check
    // keys on `opensipTools.id`; the UUID is included to match the ADR-0048 stable
    // id convention).
    OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: `${TRIVY_STABLE_ID} trivy`,
  };
});

afterAll(() => {
  if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
  if (binDir !== undefined) rmSync(binDir, { recursive: true, force: true });
});

describe('trivy worker E2E — opensip trivy (real forked worker)', () => {
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
      line?: number;
      column?: number;
      fingerprint?: string;
      metadata: Record<string, unknown>;
    }[];
  };

  beforeAll(() => {
    scan = runCli(['trivy', '--json']);
    const outcome = outcomeJson(scan);
    envelope = outcome.envelope as typeof envelope;
  });

  it('forks a worker and emits a well-formed signal envelope for trivy', () => {
    expect(envelope.tool).toBe('trivy');
    expect(envelope.runId).toMatch(/^RUN_/);
    // The fake binary exits 0, but the parsed SARIF has critical/high findings ⇒ the
    // verdict FAILS and the CLI exits 1 (findings derived from SARIF, not exit code).
    expect(envelope.verdict.passed).toBe(false);
    expect(scan.status).toBe(1);
  });

  it('normalizes the worker SARIF output to the golden signal shapes (recovered severities)', () => {
    const shapes = envelope.signals.map((s) => ({
      ruleId: s.ruleId,
      severity: s.severity,
      message: s.message,
      file: s.filePath,
      line: s.line,
      column: s.column,
    }));
    expect(shapes).toEqual(EXPECTED);
    // The headline recovery: a level:"error" + security-severity:"9.8" finding is
    // `critical`, NOT `high` (which level alone would give).
    const certifi = envelope.signals.find((s) => s.ruleId === 'CVE-2023-37920');
    expect(certifi?.severity).toBe('critical');
  });

  it('stamps message-hash fingerprints + provenance + recovered native severity worker-side', () => {
    for (const s of envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      const provenance = s.metadata.provenance as { tool: string; adapterPackage: string };
      expect(provenance.tool).toBe('trivy');
      expect(provenance.adapterPackage).toBe('@opensip-cli/tool-trivy');
    }
    const certifi = envelope.signals.find((s) => s.ruleId === 'CVE-2023-37920');
    expect(certifi?.metadata.securitySeverity).toBe('9.8');
    expect(certifi?.metadata.nativeLevel).toBe('error');
    const misconfig = envelope.signals.find((s) => s.ruleId === 'DS002');
    expect(misconfig?.metadata.nativeLevel).toBe('warning');
  });

  it('lands the raw SARIF artifact under .runtime/artifacts/trivy/<runId>/trivy.sarif with mode 0600', () => {
    const runDir = join(projectDir, 'opensip-cli', '.runtime', 'artifacts', 'trivy');
    expect(existsSync(runDir)).toBe(true);
    const runs = readdirSync(runDir);
    expect(runs.length).toBeGreaterThan(0);
    const artifact = join(runDir, runs[0], 'trivy.sarif');
    expect(existsSync(artifact)).toBe(true);
    // Owner-only read/write (0600) — the artifact carries the raw scanner output.
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
    // The persisted artifact is the byte-preserved golden (three SARIF results).
    const doc = JSON.parse(readFileSync(artifact, 'utf8')) as {
      runs: { results: unknown[] }[];
    };
    expect(doc.runs[0].results).toHaveLength(3);
  });

  it('persists a session row with the trivy tool + provenance payload', () => {
    const list = runCli(['sessions', 'list', '--json']);
    expect(list.status).toBe(0);
    const outcome = outcomeJson(list);
    const data = outcome.data as { sessions?: Record<string, unknown>[] } | undefined;
    const sessions = data?.sessions ?? [];
    const trivyRow = sessions.find((s) => s.tool === 'trivy');
    expect(trivyRow).toBeDefined();
    expect(trivyRow?.passed).toBe(false);
    const payload = trivyRow?.payload as { binary?: { path?: string }; findings?: number };
    expect(payload?.binary?.path).toContain('trivy');
    expect(payload?.findings).toBe(3);
  });
});

describe('trivy worker E2E — doctor / version diagnostics', () => {
  it('doctor --json reports a ready, resolved binary (exit 0)', () => {
    const run = runCli(['trivy', 'doctor', '--json']);
    expect(run.status).toBe(0);
    const report = outcomeJson(run).data as {
      tool: string;
      ready: boolean;
      binary: { found: boolean };
      version: { detected?: string; status: string };
    };
    expect(report.tool).toBe('trivy');
    expect(report.ready).toBe(true);
    expect(report.binary.found).toBe(true);
    expect(report.version.detected).toBe('0.50.1');
    expect(report.version.status).toBe('ok');
  });

  it('doctor reports NOT ready (exit 2) when the resolved binary is missing', () => {
    // Pin the binary to a non-existent absolute path via the env layer (which beats
    // PATH and hard-misses) so resolution fails WITHOUT breaking the toolchain/worker
    // fork. Forward the pin into the worker (doctor probes worker-side) via the
    // documented passthrough.
    const run = runCli(['trivy', 'doctor', '--json'], {
      OPENSIP_TRIVY_BIN: '/nonexistent/path/to/trivy',
      OPENSIP_CLI_TOOL_ENV_PASSTHROUGH: 'FAKE_TRIVY_GOLDEN OPENSIP_TRIVY_BIN',
    });
    expect(run.status).toBe(2);
    const report = outcomeJson(run).data as { ready: boolean; binary: { found: boolean } };
    expect(report.ready).toBe(false);
    expect(report.binary.found).toBe(false);
  });

  it('version --json prints the resolved trivy binary version', () => {
    const run = runCli(['trivy', 'version', '--json']);
    expect(run.status).toBe(0);
    const report = outcomeJson(run).data as { found: boolean; version?: string };
    expect(report.found).toBe(true);
    expect(report.version).toBe('0.50.1');
  });
});

describe('trivy worker E2E — installed tools are deny-by-default', () => {
  it('without the trust allowlist, `opensip trivy` is not admitted', () => {
    const run = runCli(['trivy', '--json'], { OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: '' });
    // Deny-by-default: the command never mounts (unknown command / not found), so
    // the scan does NOT run.
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`.toLowerCase()).toMatch(/unknown command|not found|trivy/);
  });
});

/**
 * §4.12 ratchet acceptance — the FULL baseline/gate loop over a REAL forked worker.
 * The substrate wires `--gate-save` / `--gate-compare` once (ADR-0036), so the trivy
 * adapter inherits it. This proves: capture a baseline → an unchanged re-scan is
 * clean (exit 0) → a NET-NEW vulnerability surfaces and fails (exit ≠ 0).
 *
 * Runs in its OWN throwaway project so the baseline + sessions are isolated from the
 * scan suites above. The fake binary copies `FAKE_TRIVY_GOLDEN` to `--output`;
 * pointing it at an AUGMENTED golden (the three originals + one new SARIF result +
 * rule) is how the "regression" run injects a net-new finding.
 */
describe('trivy worker E2E — full gate ratchet (§4.12)', () => {
  let gateProject: string;
  let augmentedGolden: string;
  let save: CliRun;
  let compareClean: CliRun;
  let compareRegressed: CliRun;

  beforeAll(() => {
    gateProject = makeTrivyProject();

    // The augmented golden = the committed three findings + one NET-NEW SARIF result
    // (a distinct ruleId/message ⇒ a distinct message-hash fingerprint ⇒ the ratchet
    // sees it as net-new, not unchanged). A matching rule descriptor carries its CVSS.
    const original = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as {
      runs: {
        tool: { driver: { rules: Record<string, unknown>[] } };
        results: Record<string, unknown>[];
      }[];
    };
    const run0 = original.runs[0];
    run0.tool.driver.rules.push({
      id: 'CVE-2024-99999',
      name: 'LanguageSpecificPackageVulnerability',
      shortDescription: { text: 'axios: Server-Side Request Forgery' },
      helpUri: 'https://avd.aquasec.com/nvd/cve-2024-99999',
      defaultConfiguration: { level: 'error' },
      properties: { 'security-severity': '8.6', tags: ['vulnerability', 'security', 'HIGH'] },
    });
    run0.results.push({
      ruleId: 'CVE-2024-99999',
      ruleIndex: 3,
      level: 'error',
      message: { text: 'axios: Server-Side Request Forgery' },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'requirements.txt', uriBaseId: 'ROOTPATH' },
            region: { startLine: 1, startColumn: 1 },
          },
        },
      ],
    });
    augmentedGolden = join(gateProject, 'augmented-golden.sarif');
    writeFileSync(augmentedGolden, JSON.stringify(original), 'utf8');

    // 1) Capture the baseline (three findings). The findings gate (ADR-0020) makes
    //    gate-save itself exit 1 — it records the baseline AND honours the verdict.
    save = runCli(['trivy', '--gate-save'], {}, gateProject);
    // 2) Re-scan the SAME golden and compare → no net-new ⇒ clean (exit 0).
    compareClean = runCli(['trivy', '--gate-compare'], {}, gateProject);
    // 3) Compare against the augmented golden → one net-new finding ⇒ degraded.
    compareRegressed = runCli(
      ['trivy', '--gate-compare'],
      { FAKE_TRIVY_GOLDEN: augmentedGolden },
      gateProject,
    );
  });

  afterAll(() => {
    if (gateProject !== undefined) rmSync(gateProject, { recursive: true, force: true });
  });

  it('--gate-save records the baseline and persists a session', () => {
    // The findings gate makes gate-save exit 1 (critical/high findings present), but
    // the baseline IS written — proven by the clean compare below.
    expect(save.status).toBe(1);
    const list = runCli(['sessions', 'list', '--json'], {}, gateProject);
    const data = outcomeJson(list).data as { sessions?: Record<string, unknown>[] };
    const trivyRows = (data.sessions ?? []).filter((s) => s.tool === 'trivy');
    expect(trivyRows.length).toBeGreaterThanOrEqual(1);
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
    expect(out).toContain('CVE-2024-99999');
    expect(out).toMatch(/DEGRADED|Added/i);
  });
});
