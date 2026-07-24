/**
 * Polyglot external adapter matrix E2E.
 *
 * Runs every new plan-31 adapter over the real installed-tool discovery path and
 * forked command worker, using one deterministic fake scanner binary script
 * symlinked under each scanner command name. This complements the package-local
 * golden parser tests: those prove normalization in-process, while this proves
 * install/discover/trust/worker/doctor/version/suite wiring for the new adapter
 * set without copying the large Gitleaks worker suite into every package.
 *
 * Requires `pnpm build` first. Missing dist files fail loudly.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCliJsonOutcomes } from '@opensip-cli/test-support';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const CLI_DIST = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');

interface AdapterCase {
  readonly id: string;
  readonly packageDirName: string;
  readonly binary: string;
  readonly fixture: string;
  readonly expected: string;
  readonly output: 'file' | 'stdout';
  readonly artifact: string;
  readonly envVar?: string;
}

const ADAPTERS: readonly AdapterCase[] = [
  {
    id: 'semgrep',
    packageDirName: 'tool-semgrep',
    binary: 'semgrep',
    fixture: 'semgrep-golden.sarif',
    expected: 'expected-signals.json',
    output: 'file',
    artifact: 'semgrep.sarif',
  },
  {
    id: 'ast-grep',
    packageDirName: 'tool-ast-grep',
    binary: 'ast-grep',
    fixture: 'ast-grep-golden.sarif',
    expected: 'expected-signals.json',
    output: 'stdout',
    artifact: 'ast-grep.sarif',
  },
  {
    id: 'ruff',
    packageDirName: 'tool-ruff',
    binary: 'ruff',
    fixture: 'ruff-golden.json',
    expected: 'expected-signals.json',
    output: 'file',
    artifact: 'ruff.json',
  },
  {
    id: 'golangci-lint',
    packageDirName: 'tool-golangci-lint',
    binary: 'golangci-lint',
    fixture: 'golangci-lint-golden.json',
    expected: 'expected-signals.json',
    output: 'stdout',
    artifact: 'golangci-lint.json',
  },
  {
    id: 'govulncheck',
    packageDirName: 'tool-govulncheck',
    binary: 'govulncheck',
    fixture: 'govulncheck-golden.jsonl',
    expected: 'expected-signals.json',
    output: 'stdout',
    artifact: 'govulncheck.jsonl',
  },
  {
    id: 'cargo-deny',
    packageDirName: 'tool-cargo-deny',
    binary: 'cargo-deny',
    fixture: 'cargo-deny-golden.jsonl',
    expected: 'expected-signals.json',
    output: 'stdout',
    artifact: 'cargo-deny.jsonl',
  },
  {
    id: 'bandit',
    packageDirName: 'tool-bandit',
    binary: 'bandit',
    fixture: 'bandit-golden.json',
    expected: 'expected-signals.json',
    output: 'file',
    artifact: 'bandit.json',
  },
  {
    id: 'pip-audit',
    packageDirName: 'tool-pip-audit',
    binary: 'pip-audit',
    fixture: 'pip-audit-golden.json',
    expected: 'expected-signals.json',
    output: 'file',
    artifact: 'pip-audit.json',
  },
  {
    id: 'cargo-clippy',
    packageDirName: 'tool-cargo-clippy',
    binary: 'cargo',
    fixture: 'cargo-clippy-golden.jsonl',
    expected: 'expected-signals.json',
    output: 'stdout',
    artifact: 'cargo-clippy.jsonl',
    envVar: 'OPENSIP_CARGO_CLIPPY_BIN',
  },
  {
    id: 'spotbugs',
    packageDirName: 'tool-spotbugs',
    binary: 'spotbugs',
    fixture: 'spotbugs-golden.sarif',
    expected: 'expected-signals.json',
    output: 'file',
    artifact: 'spotbugs.sarif',
  },
  {
    id: 'pmd',
    packageDirName: 'tool-pmd',
    binary: 'pmd',
    fixture: 'pmd-golden.sarif',
    expected: 'expected-signals.json',
    output: 'file',
    artifact: 'pmd.sarif',
  },
  {
    id: 'dependency-check',
    packageDirName: 'tool-dependency-check',
    binary: 'dependency-check',
    fixture: 'dependency-check-golden.sarif',
    expected: 'expected-signals.json',
    output: 'file',
    artifact: 'dependency-check-report.sarif',
  },
  {
    id: 'cppcheck',
    packageDirName: 'tool-cppcheck',
    binary: 'cppcheck',
    fixture: 'cppcheck-golden.sarif',
    expected: 'expected-signals.json',
    output: 'file',
    artifact: 'cppcheck.sarif',
  },
] as const;

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

let projectDir: string;
let binDir: string;
let baseEnv: Record<string, string>;

function packageDir(adapter: AdapterCase): string {
  return join(REPO_ROOT, 'packages', adapter.packageDirName);
}

function fixturePath(adapter: AdapterCase): string {
  return join(packageDir(adapter), '__fixtures__', adapter.fixture);
}

function expectedPath(adapter: AdapterCase): string {
  return join(packageDir(adapter), '__fixtures__', adapter.expected);
}

function defaultEnvVar(tool: string): string {
  return `OPENSIP_${tool.replaceAll('-', '_').toUpperCase()}_BIN`;
}

function parseOutcome(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function runCli(
  args: readonly string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 60_000,
): CliRun {
  try {
    const stdout = execFileSync(process.execPath, [CLI_DIST, ...args], {
      cwd: projectDir,
      env: { ...process.env, ...baseEnv, ...extraEnv },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
}

function latestArtifact(project: string, adapter: AdapterCase): string {
  const root = join(project, 'opensip-cli', '.runtime', 'artifacts', adapter.id);
  const runs = readdirSync(root)
    .filter((name) => name.startsWith('RUN_'))
    .sort();
  expect(runs.length).toBeGreaterThan(0);
  return join(root, runs.at(-1) ?? '', adapter.artifact);
}

function installAdapters(project: string): void {
  const scopeDir = join(project, 'node_modules', '@opensip-cli');
  mkdirSync(scopeDir, { recursive: true });
  for (const adapter of ADAPTERS) {
    symlinkSync(packageDir(adapter), join(scopeDir, adapter.packageDirName), 'dir');
  }
}

function createProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opensip-polyglot-adapter-e2e-'));
  writeFileSync(join(dir, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
  writeFileSync(join(dir, 'sgconfig.yml'), 'ruleDirs: []\n', 'utf8');
  writeFileSync(join(dir, 'requirements.txt'), 'flask==1.0\n', 'utf8');
  mkdirSync(join(dir, 'target', 'classes'), { recursive: true });
  installAdapters(dir);
  return dir;
}

function writeFakeScanner(): void {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const invoked = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const fixtures = JSON.parse(process.env.OPENSIP_ADAPTER_MATRIX_FIXTURES || '{}');
const tool = invoked === 'cargo' ? 'cargo-clippy' : invoked;
const versions = {
  semgrep: '1.70.0',
  'ast-grep': '0.25.7',
  ruff: 'ruff 0.5.0',
  'golangci-lint': 'golangci-lint has version 2.0.0 built with fake',
  govulncheck: 'govulncheck version v1.1.0',
  'cargo-deny': 'cargo-deny 0.14.0',
  bandit: 'bandit 1.7.0',
  'pip-audit': 'pip-audit 2.7.0',
  'cargo-clippy': 'clippy 0.1.0',
  spotbugs: '4.8.0',
  pmd: '7.0.0',
  'dependency-check': 'Dependency-Check Core version 9.0.0',
  cppcheck: 'Cppcheck 2.16.0'
};
// Exit models must match each adapter exitCodes contract: govulncheck
// -json always exits 0 (findings from parse); dependency-check findings live
// in SARIF while process exit stays 0 on clean tool execution.
const exitCodes = {
  semgrep: 1,
  'ast-grep': 1,
  ruff: 1,
  'golangci-lint': 1,
  govulncheck: 0,
  'cargo-deny': 2,
  bandit: 1,
  'pip-audit': 1,
  'cargo-clippy': 101,
  spotbugs: 1,
  pmd: 4,
  'dependency-check': 0,
  cppcheck: 0
};
function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
function outputPath() {
  if (tool === 'semgrep') return valueAfter('--output');
  if (tool === 'ruff') return valueAfter('--output-file');
  if (tool === 'bandit') return valueAfter('-o');
  if (tool === 'pip-audit') return valueAfter('--output');
  if (tool === 'spotbugs') return valueAfter('-output');
  if (tool === 'pmd') return valueAfter('-r');
  // Adapter passes --out as the full SARIF file path (not a directory).
  if (tool === 'dependency-check') return valueAfter('--out');
  if (tool === 'cppcheck') {
    const arg = args.find((entry) => entry.startsWith('--output-file='));
    return arg === undefined ? undefined : arg.slice('--output-file='.length);
  }
  return undefined;
}
const isVersion =
  args.includes('--version') ||
  args.includes('-version') ||
  (invoked === 'cargo' && args[0] === 'clippy' && args.includes('--version'));
if (isVersion) {
  process.stdout.write((versions[tool] || '1.0.0') + '\\n');
  process.exit(0);
}
if (process.env.OPENSIP_ADAPTER_MATRIX_FAULT_TOOL === tool) {
  process.stderr.write(tool + ' forced scanner fault\\n');
  process.exit(2);
}
const fixture = fixtures[tool];
if (!fixture) {
  process.stderr.write('no fixture for ' + tool + '\\n');
  process.exit(2);
}
const raw = fs.readFileSync(fixture);
const out = outputPath();
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, raw);
} else {
  process.stdout.write(raw);
}
process.exit(exitCodes[tool] ?? 1);
`;
  const fakeScannerPath = join(binDir, 'opensip-fake-scanner');
  writeFileSync(fakeScannerPath, script, { mode: 0o755 });
  for (const binary of new Set(ADAPTERS.map((adapter) => adapter.binary))) {
    symlinkSync(fakeScannerPath, join(binDir, binary));
  }
}

function expectedSignals(adapter: AdapterCase): unknown[] {
  return JSON.parse(readFileSync(expectedPath(adapter), 'utf8')) as unknown[];
}

function signalShape(signal: Record<string, unknown>): Record<string, unknown> {
  return {
    ruleId: signal.ruleId,
    severity: signal.severity,
    message: signal.message,
    file: signal.filePath,
    ...(signal.line === undefined ? {} : { line: signal.line }),
    ...(signal.column === undefined ? {} : { column: signal.column }),
  };
}

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`built CLI not found at ${CLI_DIST} - run \`pnpm build\` first`);
  }
  for (const adapter of ADAPTERS) {
    const dist = join(packageDir(adapter), 'dist', 'index.js');
    if (!existsSync(dist)) {
      throw new Error(`built ${adapter.packageDirName} dist not found at ${dist}`);
    }
  }

  projectDir = createProject();
  binDir = mkdtempSync(join(tmpdir(), 'opensip-polyglot-adapter-bin-'));
  writeFakeScanner();
  baseEnv = {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: ADAPTERS.map((adapter) => adapter.id).join(' '),
    OPENSIP_CLI_TOOL_ENV_PASSTHROUGH: 'OPENSIP_ADAPTER_MATRIX_FIXTURES',
    OPENSIP_ADAPTER_MATRIX_FIXTURES: JSON.stringify(
      Object.fromEntries(ADAPTERS.map((adapter) => [adapter.id, fixturePath(adapter)])),
    ),
  };
});

afterAll(() => {
  if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
  if (binDir !== undefined) rmSync(binDir, { recursive: true, force: true });
});

describe('polyglot external adapters — worker scan matrix', () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter.id} scans through the forked worker and normalizes the golden fixture`, () => {
      const run = runCli([adapter.id, '--json']);
      const outcome = parseOutcome(run.stdout);
      const envelope = outcome.envelope as {
        tool: string;
        verdict: { passed: boolean };
        signals: Record<string, unknown>[];
      };

      expect(envelope.tool).toBe(adapter.id);
      expect(envelope.verdict.passed).toBeTypeOf('boolean');
      expect(envelope.signals.map(signalShape)).toEqual(expectedSignals(adapter));
      for (const signal of envelope.signals) {
        expect(signal.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      }
      const artifact = latestArtifact(projectDir, adapter);
      expect(readFileSync(artifact, 'utf8').trim()).toBe(
        readFileSync(fixturePath(adapter), 'utf8').trim(),
      );
    });
  }
});

describe('polyglot external adapters — doctor and version matrix', () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter.id} doctor/version run worker-side against the fake binary`, () => {
      const doctor = runCli([adapter.id, 'doctor', '--json']);
      const version = runCli([adapter.id, 'version', '--json']);
      const doctorReport = parseOutcome(doctor.stdout).data as {
        tool: string;
        ready: boolean;
        binary: { found: boolean };
      };
      const versionReport = parseOutcome(version.stdout).data as {
        tool: string;
        found: boolean;
        version?: string;
      };

      expect(doctor.status).toBe(0);
      expect(doctorReport.tool).toBe(adapter.id);
      expect(doctorReport.ready).toBe(true);
      expect(doctorReport.binary.found).toBe(true);
      expect(version.status).toBe(0);
      expect(versionReport.tool).toBe(adapter.id);
      expect(versionReport.found).toBe(true);
      expect(versionReport.version).toBeTypeOf('string');
    });

    it(`${adapter.id} doctor reports not-ready for a broken binary pin`, () => {
      const envVar = adapter.envVar ?? defaultEnvVar(adapter.id);
      const run = runCli([adapter.id, 'doctor', '--json'], {
        [envVar]: '/definitely/missing/opensip-scanner',
        OPENSIP_CLI_TOOL_ENV_PASSTHROUGH: `OPENSIP_ADAPTER_MATRIX_FIXTURES ${envVar}`,
      });
      const report = parseOutcome(run.stdout).data as {
        ready: boolean;
        binary: { found: boolean };
      };

      expect(run.status).toBe(2);
      expect(report.ready).toBe(false);
      expect(report.binary.found).toBe(false);
    });

    it(`${adapter.id} scanner faults surface as command failures`, () => {
      const run = runCli([adapter.id, '--json'], {
        OPENSIP_ADAPTER_MATRIX_FAULT_TOOL: adapter.id,
        OPENSIP_CLI_TOOL_ENV_PASSTHROUGH:
          'OPENSIP_ADAPTER_MATRIX_FIXTURES OPENSIP_ADAPTER_MATRIX_FAULT_TOOL',
      });
      const outcome = parseOutcome(run.stdout) as {
        kind?: string;
        errors?: { message?: string }[];
      };

      expect(run.status).not.toBe(0);
      expect(outcome.kind).toBe('command.error');
      expect(outcome.errors?.[0]?.message).toBe('The operation failed.');
      expect(outcome.errors?.[0]?.message).not.toContain(`${adapter.id} scan failed (exit 2)`);
    });
  }
});

describe('polyglot external adapters — suite step matrix', () => {
  it('runs every new adapter as a suite step over the forked worker boundary', () => {
    for (const adapter of ADAPTERS) {
      const add = runCli([
        'suite',
        'add',
        'polyglot-adapters',
        '--tool',
        adapter.id,
        '--command',
        adapter.id,
      ]);
      expect(add.status).toBe(0);
    }

    const suite = runCli(['suite', 'run', 'polyglot-adapters', '--json'], {}, 180_000);
    const outcomes = parseCliJsonOutcomes(suite.stdout);
    const suiteRun = outcomes.find((outcome) => outcome.kind === 'suite-run');
    const data = suiteRun?.data as
      | {
          exitCode: number;
          steps: { tool: string; command: string; exitCode: number }[];
        }
      | undefined;

    expect(suite.status).toBe(1);
    expect(data?.exitCode).toBe(1);
    expect(data?.steps).toHaveLength(ADAPTERS.length);
    expect(data?.steps.map((step) => step.command)).toEqual(ADAPTERS.map((adapter) => adapter.id));
    for (const adapter of ADAPTERS) {
      expect(existsSync(latestArtifact(projectDir, adapter))).toBe(true);
    }
  }, 120_000);
});
