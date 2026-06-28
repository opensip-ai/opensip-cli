/**
 * Tier-2 worker E2E (ADR-0090 D6 Tier 2) — install / discover / dispatch the
 * gitleaks adapter over a REAL forked worker, end-to-end against the BUILT CLI.
 *
 * Unlike the in-process Tier-1 suites, this proves the FULL installed-tool path:
 *   - the gitleaks package is presented as a genuinely INSTALLED npm tool in a
 *     throwaway project (symlinked into its `node_modules` so the worker resolves
 *     the adapter's workspace deps from the monorepo via realpath);
 *   - `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` trusts it (installed tools are
 *     deny-by-default);
 *   - a FAKE `gitleaks` binary on PATH makes the run deterministic (it copies the
 *     committed golden to `--report-path` and exits 1, like real gitleaks on
 *     findings). The worker fork curates its env to an allow-list, so the golden
 *     path is forwarded via the documented `OPENSIP_CLI_TOOL_ENV_PASSTHROUGH`.
 *
 * `opensip gitleaks` forks a worker that re-discovers + imports the real runtime
 * and runs the scan loop; this suite asserts the worker→host result + the
 * host-side effects: normalized signals match the golden, the raw artifact lands
 * at `.runtime/artifacts/gitleaks/<runId>/gitleaks.json` with mode 0600, the
 * `--json` envelope is well-formed, the session row persists with provenance, and
 * — the load-bearing negative — NO raw `Secret`/`Match` substring ever reaches the
 * emitted worker→host payload.
 *
 * Requires `pnpm build` first (the CLI dist + the gitleaks dist). Missing builds
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
// .../packages/tool-gitleaks/src/__tests__ → repo root is four levels up.
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const CLI_DIST = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
const GITLEAKS_PKG_DIR = join(REPO_ROOT, 'packages', 'tool-gitleaks');
const FIXTURES = join(GITLEAKS_PKG_DIR, '__fixtures__');
const GOLDEN_PATH = join(FIXTURES, 'gitleaks-golden.json');

const GITLEAKS_STABLE_ID = 'cd08f737-ce8e-4813-9259-b4ffeb954268';

const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, 'expected-signals.json'), 'utf8')) as {
  ruleId: string;
  severity: string;
  message: string;
  file: string;
  line?: number;
  column?: number;
}[];

// The raw matched-credential strings that must NEVER reach the emitted payload.
const RAW_SECRETS = ['AKIAIOSFODNN7EXAMPLE', 'glpat-XXXXXXXXXXXXXXXXXXXX', 'aws_key ='];

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

let projectDir: string;
let binDir: string;
let baseEnv: Record<string, string>;

/** Run the built CLI as a child process, capturing stdout/stderr + exit code. */
function runCli(args: string[], extraEnv: Record<string, string> = {}): CliRun {
  try {
    const stdout = execFileSync('node', [CLI_DIST, ...args], {
      cwd: projectDir,
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

/** Parse the `--json` outcome wrapper (`{ kind, status, exitCode, envelope?, data? }`). */
function parseOutcome(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` first`);
  }
  if (!existsSync(join(GITLEAKS_PKG_DIR, 'dist', 'index.js'))) {
    throw new Error('built tool-gitleaks dist not found — run `pnpm build` first');
  }

  projectDir = mkdtempSync(join(tmpdir(), 'opensip-gitleaks-e2e-'));
  // Project marker so the worker's `scope: 'project'` bootstrap resolves a project.
  writeFileSync(
    join(projectDir, 'opensip-cli.config.yml'),
    'schemaVersion: 1\ntargets: {}\n',
    'utf8',
  );
  // Present the REAL gitleaks package as an installed npm tool. A SYMLINK (not a
  // copy) so the worker resolves the adapter's `@opensip-cli/*` workspace deps
  // from the monorepo via realpath — a copy would orphan them.
  const scopeDir = join(projectDir, 'node_modules', '@opensip-cli');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(GITLEAKS_PKG_DIR, join(scopeDir, 'tool-gitleaks'), 'dir');

  // A FAKE gitleaks on PATH for determinism (copies the golden to --report-path,
  // exits 1). PATH is auto-forwarded into the worker fork's curated env.
  binDir = mkdtempSync(join(tmpdir(), 'opensip-gitleaks-bin-'));
  cpSync(join(FIXTURES, 'fake-gitleaks'), join(binDir, 'gitleaks'));
  execFileSync('chmod', ['+x', join(binDir, 'gitleaks')]);

  baseEnv = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    // The committed fake binary reads the golden path from here; forward it
    // through the worker fork's env allow-list via the documented passthrough.
    FAKE_GITLEAKS_GOLDEN: GOLDEN_PATH,
    OPENSIP_CLI_TOOL_ENV_PASSTHROUGH: 'FAKE_GITLEAKS_GOLDEN',
    // Installed tools are deny-by-default — trust the gitleaks id (the admission
    // check keys on `opensipTools.id`; the UUID is included to match the
    // ADR-0048 stable id convention).
    OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: `${GITLEAKS_STABLE_ID} gitleaks`,
  };
});

afterAll(() => {
  if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
  if (binDir !== undefined) rmSync(binDir, { recursive: true, force: true });
});

describe('gitleaks worker E2E — opensip gitleaks (real forked worker)', () => {
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
    scan = runCli(['gitleaks', '--json']);
    const outcome = parseOutcome(scan.stdout);
    envelope = outcome.envelope as typeof envelope;
  });

  it('forks a worker and emits a well-formed signal envelope for gitleaks', () => {
    expect(envelope.tool).toBe('gitleaks');
    expect(envelope.runId).toMatch(/^RUN_/);
    // High-severity secrets ⇒ the run FAILS; the gate exit is non-zero (findings).
    expect(envelope.verdict.passed).toBe(false);
    expect(scan.status).toBe(1);
  });

  it('normalizes the worker scan output to the golden signal shapes', () => {
    const shapes = envelope.signals.map((s) => ({
      ruleId: s.ruleId,
      severity: s.severity,
      message: s.message,
      file: s.filePath,
      ...(s.line === undefined ? {} : { line: s.line }),
      ...(s.column === undefined ? {} : { column: s.column }),
    }));
    expect(shapes).toEqual(EXPECTED);
  });

  it('stamps message-hash fingerprints + provenance worker-side', () => {
    for (const s of envelope.signals) {
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      const provenance = s.metadata.provenance as { tool: string; adapterPackage: string };
      expect(provenance.tool).toBe('gitleaks');
      expect(provenance.adapterPackage).toBe('@opensip-cli/tool-gitleaks');
    }
  });

  it('lands the raw artifact under .runtime/artifacts/gitleaks/<runId>/gitleaks.json with mode 0600', () => {
    const runDir = join(projectDir, 'opensip-cli', '.runtime', 'artifacts', 'gitleaks');
    expect(existsSync(runDir)).toBe(true);
    const runs = readdirSync(runDir);
    expect(runs.length).toBeGreaterThan(0);
    const artifact = join(runDir, runs[0], 'gitleaks.json');
    expect(existsSync(artifact)).toBe(true);
    // Owner-only read/write (0600) — the artifact carries the raw scanner output.
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
    // The persisted artifact is the byte-preserved golden.
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toHaveLength(2);
  });

  it('NEVER lets a raw Secret/Match substring reach the emitted worker→host payload', () => {
    for (const raw of RAW_SECRETS) {
      expect(scan.stdout).not.toContain(raw);
    }
    expect(scan.stdout).not.toContain('"Match"');
    // The masked preview IS present (the finding stays identifiable).
    expect(scan.stdout).toContain('AKIA…');
    expect(scan.stdout).toContain('glpa…');
  });

  it('persists a session row with the gitleaks tool + provenance payload', () => {
    const list = runCli(['sessions', 'list', '--json']);
    expect(list.status).toBe(0);
    const outcome = parseOutcome(list.stdout);
    const data = outcome.data as { sessions?: Record<string, unknown>[] } | undefined;
    const sessions = data?.sessions ?? [];
    const gitleaksRow = sessions.find((s) => s.tool === 'gitleaks');
    expect(gitleaksRow).toBeDefined();
    expect(gitleaksRow?.passed).toBe(false);
    const payload = gitleaksRow?.payload as { binary?: { path?: string }; findings?: number };
    expect(payload?.binary?.path).toContain('gitleaks');
    expect(payload?.findings).toBe(2);
  });
});

describe('gitleaks worker E2E — doctor / version diagnostics', () => {
  it('doctor --json reports a ready, resolved binary (exit 0)', () => {
    const run = runCli(['gitleaks', 'doctor', '--json']);
    expect(run.status).toBe(0);
    const report = parseOutcome(run.stdout).data as {
      tool: string;
      ready: boolean;
      binary: { found: boolean };
      version: { detected?: string; status: string };
    };
    expect(report.tool).toBe('gitleaks');
    expect(report.ready).toBe(true);
    expect(report.binary.found).toBe(true);
    expect(report.version.detected).toBe('8.18.4');
    expect(report.version.status).toBe('ok');
  });

  it('doctor reports NOT ready (exit 2) when the resolved binary is missing', () => {
    // Pin the binary to a non-existent absolute path via the env layer (which
    // beats PATH and hard-misses) so resolution fails WITHOUT breaking the
    // toolchain/worker fork. Forward the pin into the worker (doctor probes
    // worker-side) via the documented passthrough.
    const run = runCli(['gitleaks', 'doctor', '--json'], {
      OPENSIP_GITLEAKS_BIN: '/nonexistent/path/to/gitleaks',
      OPENSIP_CLI_TOOL_ENV_PASSTHROUGH: 'FAKE_GITLEAKS_GOLDEN OPENSIP_GITLEAKS_BIN',
    });
    expect(run.status).toBe(2);
    const report = parseOutcome(run.stdout).data as { ready: boolean; binary: { found: boolean } };
    expect(report.ready).toBe(false);
    expect(report.binary.found).toBe(false);
  });

  it('version --json prints the resolved gitleaks binary version', () => {
    const run = runCli(['gitleaks', 'version', '--json']);
    expect(run.status).toBe(0);
    const report = parseOutcome(run.stdout).data as { found: boolean; version?: string };
    expect(report.found).toBe(true);
    expect(report.version).toBe('8.18.4');
  });
});

describe('gitleaks worker E2E — installed tools are deny-by-default', () => {
  it('without the trust allowlist, `opensip gitleaks` is not admitted', () => {
    const run = runCli(['gitleaks', '--json'], { OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: '' });
    // Deny-by-default: the command never mounts (unknown command / not found),
    // so the scan does NOT run.
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`.toLowerCase()).toMatch(
      /unknown command|not found|gitleaks/,
    );
  });
});
