/**
 * 04↔05 integration E2E — an EXTERNAL tool adapter (plan 04) runs as a host-owned
 * SUITE step (plan 05 / ADR-0093) over the REAL forked-worker boundary, end-to-end
 * against the BUILT CLI.
 *
 * This locks in the seam between the two planes that otherwise only meet at run
 * time: the gitleaks adapter is an installed, EXTERNAL-provenance tool, so when it
 * appears as a `suites:` step the orchestrator's `maybeDispatchExternal` hook MUST
 * fork the ADR-0054 worker (it never runs the untrusted runtime in-host), and the
 * worker's verdict MUST flow back into the suite's worst-of exit aggregation.
 *
 * The harness mirrors `worker-e2e.test.ts` (least-effort path): the REAL gitleaks
 * package is presented as an installed npm tool (symlinked into the throwaway
 * project's `node_modules` so the worker resolves its `@opensip-cli/*` workspace
 * deps via realpath), a FAKE `gitleaks` on PATH makes the scan deterministic (copy
 * the committed golden to `--report-path`, exit 1 like real gitleaks on findings),
 * and `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` trusts it (installed tools are
 * deny-by-default). The fake's golden path rides the documented
 * `OPENSIP_CLI_TOOL_ENV_PASSTHROUGH` into the worker fork's curated env.
 *
 * What it proves:
 *   - `suite add security --tool gitleaks --command gitleaks` resolves the tool
 *     NAME to its canonical `ToolMetadata.id` UUID in `opensip-cli.config.yml`.
 *   - `suite run security` dispatches the step through the forked worker: the raw
 *     artifact lands at `.runtime/artifacts/gitleaks/<runId>/gitleaks.json`
 *     (mode 0600 in a 0700 dir) — the worker boundary actually ran the scan.
 *   - the gitleaks findings verdict propagates into the suite worst-of exit
 *     (the 2 fixture secrets trip the findings gate ⇒ the suite exits non-zero,
 *     the step summary records exit 1).
 *   - the run persists under the suite grouping (`suiteRunId` / `suiteName`) with
 *     the gitleaks verdict + finding count.
 *   - the secret-egress guarantee STILL holds inside a suite (no raw `Secret`/
 *     `Match` reaches the emitted output; only the masked preview survives).
 *   - deny-by-default STILL applies in suite context: WITHOUT the trust env the
 *     step is denied (non-zero exit, no artifact, no session) — it never silently
 *     succeeds.
 *
 * Requires `pnpm build` first (the CLI dist + the gitleaks dist). Missing builds
 * FAIL loudly (no silent skip).
 *
 * NOTE on the step command name: the adapter declares its scan command as `scan`,
 * but `defineExternalToolAdapter` makes the first command the PRIMARY, which
 * `defineTool` names from `identity.name` — so the resolvable `commandSpecs` name
 * (and the suite step `command`) is `gitleaks`, not `scan`. `suite add --command
 * scan` is rejected (`CONFIG.SUITE_ADD.UNKNOWN_COMMAND`, exit 2).
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

// The gitleaks adapter's stable `ToolMetadata.id` (ADR-0048). Suite steps address
// tools by this UUID; `suite add --tool gitleaks` must resolve the name to it.
const GITLEAKS_STABLE_ID = 'cd08f737-ce8e-4813-9259-b4ffeb954268';

// Raw matched-credential strings that must NEVER reach the emitted payload.
const RAW_SECRETS = ['AKIAIOSFODNN7EXAMPLE', 'glpat-XXXXXXXXXXXXXXXXXXXX', 'aws_key ='];

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

let binDir: string;
let baseEnv: Record<string, string>;

/** Run the built CLI as a child process, capturing stdout/stderr + exit code. */
function runCli(args: string[], extraEnv: Record<string, string>, cwd: string): CliRun {
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

/** Scaffold a throwaway opensip-cli project that resolves the installed gitleaks tool. */
function makeSuiteProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-gitleaks-suite-'));
  writeFileSync(join(dir, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
  // SYMLINK (not a copy) so the worker resolves the adapter's `@opensip-cli/*`
  // workspace deps from the monorepo via realpath — a copy would orphan them.
  const scopeDir = join(dir, 'node_modules', '@opensip-cli');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(GITLEAKS_PKG_DIR, join(scopeDir, 'tool-gitleaks'), 'dir');
  return dir;
}

/** Split the CLI's concatenated top-level `--json` outcome documents. */
function parseOutcomes(stdout: string): Record<string, unknown>[] {
  // The CLI pretty-prints each top-level outcome object starting at column 0; a
  // `suite run --json` emits the step's gitleaks envelope outcome AND the suite-run
  // outcome back-to-back. Split before each line-leading `{`, then JSON.parse each.
  return stdout
    .split(/\n(?=\{)/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('{'))
    .map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
}

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`built CLI not found at ${CLI_DIST} — run \`pnpm build\` first`);
  }
  if (!existsSync(join(GITLEAKS_PKG_DIR, 'dist', 'index.js'))) {
    throw new Error('built tool-gitleaks dist not found — run `pnpm build` first');
  }

  // A FAKE gitleaks on PATH for determinism (copies the golden to --report-path,
  // exits 1). PATH is auto-forwarded into the worker fork's curated env.
  binDir = mkdtempSync(join(tmpdir(), 'opensip-gitleaks-suite-bin-'));
  cpSync(join(FIXTURES, 'fake-gitleaks'), join(binDir, 'gitleaks'));
  execFileSync('chmod', ['+x', join(binDir, 'gitleaks')]);

  baseEnv = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_GITLEAKS_GOLDEN: GOLDEN_PATH,
    OPENSIP_CLI_TOOL_ENV_PASSTHROUGH: 'FAKE_GITLEAKS_GOLDEN',
    // Installed tools are deny-by-default — trust the gitleaks id (admission keys
    // on `opensipTools.id`; the UUID is included per the ADR-0048 stable-id rule).
    OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: `${GITLEAKS_STABLE_ID} gitleaks`,
  };
});

afterAll(() => {
  if (binDir !== undefined) rmSync(binDir, { recursive: true, force: true });
});

describe('gitleaks as a suite step (04↔05) — external adapter over the worker boundary', () => {
  let project: string;
  let configText: string;
  let addRun: CliRun;
  let suiteRun: CliRun;
  let suiteOutcome: {
    exitCode: number;
    suiteRunId: string;
    steps: { tool: string; stableId: string; command: string; exitCode: number }[];
  };

  beforeAll(() => {
    project = makeSuiteProject();

    // 1) Author the suite via `suite add` — proving it resolves the tool NAME to
    //    the canonical UUID (needs the trust env to admit the installed tool into
    //    the registry it resolves against). `--command gitleaks` is the primary
    //    command's resolvable name (see the file header NOTE).
    addRun = runCli(
      ['suite', 'add', 'security', '--tool', 'gitleaks', '--command', 'gitleaks'],
      {},
      project,
    );
    configText = readFileSync(join(project, 'opensip-cli.config.yml'), 'utf8');

    // 2) Run the suite over the real forked worker (single `--json` run drives all
    //    the structured assertions + the on-disk side effects).
    suiteRun = runCli(['suite', 'run', 'security', '--json'], {}, project);
    const outcomes = parseOutcomes(suiteRun.stdout);
    const found = outcomes.find((o) => o.kind === 'suite-run');
    if (found === undefined) {
      throw new Error(`no suite-run outcome in stdout:\n${suiteRun.stdout}`);
    }
    suiteOutcome = found.data as typeof suiteOutcome;
  });

  afterAll(() => {
    if (project !== undefined) rmSync(project, { recursive: true, force: true });
  });

  it('`suite add` resolves the tool name to its canonical UUID in config', () => {
    expect(addRun.status).toBe(0);
    expect(configText).toContain(`tool: ${GITLEAKS_STABLE_ID}`);
    expect(configText).toContain('command: gitleaks');
  });

  it('dispatches the step through the forked worker — raw artifact lands 0600 in a 0700 dir', () => {
    const runDir = join(project, 'opensip-cli', '.runtime', 'artifacts', 'gitleaks');
    expect(existsSync(runDir)).toBe(true);
    const runs = readdirSync(runDir).filter((name) => name.startsWith('RUN_'));
    expect(runs.length).toBeGreaterThan(0);
    const perRunDir = join(runDir, runs[0]);
    const artifact = join(perRunDir, 'gitleaks.json');
    // The fake binary does NOT `mkdir -p` its --report-path dir — the artifact
    // exists ONLY because the host `ensureArtifactDir` seam created the per-run dir
    // (over the worker boundary) before the scan. Its presence proves the worker
    // actually ran the gitleaks scan inside the suite step.
    expect(existsSync(artifact)).toBe(true);
    expect(statSync(perRunDir).mode & 0o777).toBe(0o700);
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
    // The persisted artifact is the byte-preserved golden (two findings).
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toHaveLength(2);
  });

  it('propagates the gitleaks findings verdict into the suite worst-of exit', () => {
    // The 2 fixture secrets trip the findings gate ⇒ the worker verdict FAILS, and
    // that must aggregate worst-of into the suite exit (process + structured both 1).
    expect(suiteRun.status).toBe(1);
    expect(suiteOutcome.exitCode).toBe(1);
    expect(suiteOutcome.suiteRunId).toMatch(/^SUITE_/);
    expect(suiteOutcome.steps).toHaveLength(1);
    const [step] = suiteOutcome.steps;
    expect(step?.tool).toBe('gitleaks');
    expect(step?.stableId).toBe(GITLEAKS_STABLE_ID);
    expect(step?.command).toBe('gitleaks');
    expect(step?.exitCode).toBe(1);
  });

  it('persists the run under the suite grouping with the gitleaks verdict', () => {
    const list = runCli(['sessions', 'list', '--json'], {}, project);
    expect(list.status).toBe(0);
    const data = parseOutcomes(list.stdout).find((o) => o.kind === 'history')?.data as {
      sessions?: Record<string, unknown>[];
    };
    const gitleaksRow = (data?.sessions ?? []).find((s) => s.tool === 'gitleaks') as
      | {
          suiteName?: string;
          suiteRunId?: string;
          passed?: boolean;
          payload?: { findings?: number };
        }
      | undefined;
    expect(gitleaksRow).toBeDefined();
    expect(gitleaksRow?.suiteName).toBe('security');
    expect(gitleaksRow?.suiteRunId ?? '').toMatch(/^SUITE_/);
    // The grouped suiteRunId matches the suite-run outcome's id (same run).
    expect(gitleaksRow?.suiteRunId).toBe(suiteOutcome.suiteRunId);
    expect(gitleaksRow?.passed).toBe(false);
    expect(gitleaksRow?.payload?.findings).toBe(2);
  });

  it('upholds the secret-egress guarantee inside the suite (masked preview only)', () => {
    for (const raw of RAW_SECRETS) {
      expect(suiteRun.stdout).not.toContain(raw);
    }
    expect(suiteRun.stdout).not.toContain('"Match"');
    expect(suiteRun.stdout).not.toContain('"Secret"');
    // The masked preview IS present (the finding stays identifiable in the suite).
    expect(suiteRun.stdout).toContain('AKIA…');
    expect(suiteRun.stdout).toContain('glpa…');
  });
});

describe('gitleaks as a suite step — deny-by-default still applies in suite context', () => {
  let project: string;
  let denied: CliRun;

  beforeAll(() => {
    project = makeSuiteProject();
    // Author the suite config DIRECTLY (the installed gitleaks IS present in
    // node_modules, so the deny is purely the trust gate, not absence of the tool).
    writeFileSync(
      join(project, 'opensip-cli.config.yml'),
      [
        'schemaVersion: 1',
        'targets: {}',
        'suites:',
        '  security:',
        '    steps:',
        `      - tool: ${GITLEAKS_STABLE_ID}`,
        '        name: gitleaks',
        '        command: gitleaks',
        '',
      ].join('\n'),
      'utf8',
    );
    // Run WITHOUT the trust allowlist (override baseEnv's trust to empty).
    denied = runCli(
      ['suite', 'run', 'security'],
      { OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: '' },
      project,
    );
  });

  afterAll(() => {
    if (project !== undefined) rmSync(project, { recursive: true, force: true });
  });

  it('denies the untrusted external step (non-zero exit — never a silent success)', () => {
    // The installed gitleaks is not admitted, so the suite's UUID-addressed step
    // resolves to no tool and the run fails (configuration error) rather than
    // silently passing.
    expect(denied.status).not.toBe(0);
  });

  it('runs no scan: no artifact and no gitleaks session were produced', () => {
    const runDir = join(project, 'opensip-cli', '.runtime', 'artifacts', 'gitleaks');
    const artifactCount = existsSync(runDir)
      ? readdirSync(runDir)
          .filter((name) => name.startsWith('RUN_'))
          .filter((name) => existsSync(join(runDir, name, 'gitleaks.json'))).length
      : 0;
    expect(artifactCount).toBe(0);

    const list = runCli(
      ['sessions', 'list', '--json'],
      { OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: '' },
      project,
    );
    const data = parseOutcomes(list.stdout).find((o) => o.kind === 'history')?.data as {
      sessions?: Record<string, unknown>[];
    };
    const gitleaksRows = (data?.sessions ?? []).filter((s) => s.tool === 'gitleaks');
    expect(gitleaksRows).toHaveLength(0);
  });
});
