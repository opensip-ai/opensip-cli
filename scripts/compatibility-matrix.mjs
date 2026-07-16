#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_CONFIG = '.config/compatibility-matrix.json';

export async function runCompatibilityMatrix(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.help === true) return { exitCode: 0, report: null, outPath: null };

  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const configPath = resolve(repoRoot, options.configPath);
  const config = await (deps.loadMatrixConfig ?? loadMatrixConfig)(configPath, deps);
  const runtime = deps.runtime ?? (await loadRuntimeModules(repoRoot));

  const report = createReport({
    configPath: relative(repoRoot, configPath),
    checkMode: options.check,
  });

  await recordCheck(report, 'policy.registry.complete', 'all', () =>
    validatePolicyRegistry(config, runtime),
  );
  await recordCheck(report, 'policy.constants.current', 'all', () =>
    validatePolicyConstants(runtime),
  );

  for (const fixture of config.fixtures) {
    await recordCheck(report, `fixture.${fixture.kind}.${fixture.path}`, fixture.contract, () =>
      validateFixture({ fixture, repoRoot, runtime, deps }),
    );
  }

  finalizeReport(report);
  const outPath = options.out === undefined ? null : resolve(repoRoot, options.out);
  if (outPath !== null) {
    await (deps.writeFile ?? writeFile)(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  printSummary(report, outPath === null ? null : relative(repoRoot, outPath), deps);
  return { exitCode: report.verdict === 'pass' ? 0 : 1, report, outPath };
}

async function loadRuntimeModules(repoRoot) {
  try {
    const [core, contracts, config] = await Promise.all([
      import(pathToFileURL(resolve(repoRoot, 'packages/core/dist/index.js')).href),
      import(pathToFileURL(resolve(repoRoot, 'packages/contracts/dist/index.js')).href),
      import(pathToFileURL(resolve(repoRoot, 'packages/config/dist/index.js')).href),
    ]);
    return { core, contracts, config };
  } catch (error) {
    throw new Error(
      `Could not load built compatibility modules. Run \`node scripts/build-ci.mjs\` first. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function loadMatrixConfig(path, deps = {}) {
  const raw = await (deps.readFile ?? readFile)(path, 'utf8');
  return normalizeMatrixConfig(JSON.parse(raw), path);
}

export function normalizeMatrixConfig(raw, path = '<memory>/compatibility-matrix.json') {
  const root = asRecord(raw, `${path} root`);
  if (root.version !== 1) throw new Error(`${path}: version must be 1.`);
  const contracts = requireArray(root.contracts, `${path}: contracts`).map((entry, index) => {
    const record = asRecord(entry, `${path}: contracts[${String(index)}]`);
    const className = requireString(record.class, `${path}: contracts[${String(index)}].class`);
    return { class: className };
  });
  const fixtures = requireArray(root.fixtures, `${path}: fixtures`).map((entry, index) => {
    const record = asRecord(entry, `${path}: fixtures[${String(index)}]`);
    return {
      contract: requireString(record.contract, `${path}: fixtures[${String(index)}].contract`),
      kind: requireString(record.kind, `${path}: fixtures[${String(index)}].kind`),
      path: requireString(record.path, `${path}: fixtures[${String(index)}].path`),
      expectChanged: typeof record.expectChanged === 'boolean' ? record.expectChanged : undefined,
    };
  });
  return { version: 1, contracts, fixtures };
}

function createReport({ configPath, checkMode }) {
  return {
    generatedAt: new Date().toISOString(),
    configPath,
    checkMode,
    verdict: 'pass',
    counts: { pass: 0, fail: 0 },
    checks: [],
  };
}

async function recordCheck(report, id, contract, fn) {
  try {
    const details = await fn();
    report.checks.push({
      id,
      contract,
      status: 'pass',
      details: details ?? {},
    });
  } catch (error) {
    report.checks.push({
      id,
      contract,
      status: 'fail',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function finalizeReport(report) {
  report.counts.pass = report.checks.filter((check) => check.status === 'pass').length;
  report.counts.fail = report.checks.length - report.counts.pass;
  report.verdict = report.counts.fail === 0 ? 'pass' : 'fail';
}

function validatePolicyRegistry(config, runtime) {
  runtime.core.assertCompatibilityPoliciesComplete();
  const expected = [...runtime.core.COMPATIBILITY_CONTRACT_CLASSES].sort();
  const actual = config.contracts.map((entry) => entry.class).sort();
  assertEqual(actual, expected, 'compatibility matrix contract classes must match registry');
  const missing = actual.filter(
    (className) => runtime.core.findCompatibilityPolicy(className) === undefined,
  );
  assertCondition(missing.length === 0, `missing policy rows: ${missing.join(', ')}`);
  return { contracts: actual };
}

function validatePolicyConstants(runtime) {
  const checks = [
    ['cli-command-surface', runtime.core.CLI_COMMAND_SURFACE_CONTRACT_VERSION],
    ['project-config', runtime.core.CLI_SUPPORTED_SCHEMA_VERSION],
    ['public-json', runtime.core.PUBLIC_JSON_CONTRACT_VERSION],
    ['tool-plugin-api', runtime.core.PLUGIN_API_VERSION],
    ['cloud-wire', runtime.core.CLOUD_WIRE_CONTRACT_VERSION],
    ['release-artifact', runtime.core.RELEASE_ARTIFACT_CONTRACT_VERSION],
    ['datastore-payload', runtime.core.DATASTORE_PAYLOAD_CONTRACT_VERSION],
    ['platform-support', runtime.core.PLATFORM_SUPPORT_CONTRACT_VERSION],
  ];
  for (const [className, version] of checks) {
    const policy = runtime.core.findCompatibilityPolicy(className);
    assertCondition(policy !== undefined, `missing compatibility policy for ${className}`);
    assertEqual(policy.version, version, `${className} policy version drifted from code constant`);
  }
  assertEqual(
    runtime.contracts.SIGNAL_ENVELOPE_SCHEMA_VERSION,
    runtime.core.PUBLIC_JSON_CONTRACT_VERSION,
    'SignalEnvelope schema version must match the public-json policy version',
  );
  assertEqual(
    runtime.core.SIGNAL_BATCH_SCHEMA_VERSION,
    runtime.core.CLOUD_WIRE_CONTRACT_VERSION,
    'SignalBatch schema version must match the cloud-wire policy version',
  );
  assertEqual(
    runtime.contracts.COMMAND_OUTCOME_CONTRACT_VERSION,
    1,
    'CommandOutcome contract version must stay explicit',
  );
  return { checked: checks.length + 3 };
}

async function validateFixture({ fixture, repoRoot, runtime, deps }) {
  const fixturePath = resolve(repoRoot, fixture.path);
  if (fixture.kind === 'config-migration') {
    return validateConfigMigrationFixture({ fixture, fixturePath, runtime, deps });
  }
  const raw = await (deps.readFile ?? readFile)(fixturePath, 'utf8');
  const json = JSON.parse(raw);
  switch (fixture.kind) {
    case 'signal-envelope': {
      validateSignalEnvelope(json, runtime.contracts.SIGNAL_ENVELOPE_SCHEMA_VERSION);
      return { path: fixture.path, schemaVersion: json.schemaVersion };
    }
    case 'command-outcome': {
      validateCommandOutcome(json, runtime);
      return {
        path: fixture.path,
        contractVersion: runtime.contracts.COMMAND_OUTCOME_CONTRACT_VERSION,
      };
    }
    case 'signal-batch': {
      validateSignalBatch(json, runtime.core.SIGNAL_BATCH_SCHEMA_VERSION);
      return { path: fixture.path, schemaVersion: json.schemaVersion };
    }
    default: {
      throw new Error(`Unknown fixture kind '${fixture.kind}'.`);
    }
  }
}

async function validateConfigMigrationFixture({ fixture, fixturePath, runtime, deps }) {
  const text = await (deps.readFile ?? readFile)(fixturePath, 'utf8');
  const result = runtime.config.migrateConfigText({ text, configPath: fixturePath });
  if (fixture.expectChanged !== undefined) {
    assertEqual(
      result.changed,
      fixture.expectChanged,
      `${fixture.path} migration changed expectation mismatch`,
    );
  }
  assertCondition(
    result.migratedText.includes(
      `schemaVersion: ${String(runtime.core.CLI_SUPPORTED_SCHEMA_VERSION)}`,
    ),
    `${fixture.path} migration output must contain current schemaVersion`,
  );
  return {
    path: fixture.path,
    changed: result.changed,
    targetVersion: result.targetVersion,
  };
}

function validateSignalEnvelope(value, expectedVersion) {
  const envelope = asRecord(value, 'signal-envelope fixture');
  assertEqual(envelope.schemaVersion, expectedVersion, 'signal envelope schemaVersion mismatch');
  requireString(envelope.tool, 'signal-envelope.tool');
  requireString(envelope.runId, 'signal-envelope.runId');
  requireString(envelope.createdAt, 'signal-envelope.createdAt');
  asRecord(envelope.verdict, 'signal-envelope.verdict');
  requireArray(envelope.units, 'signal-envelope.units');
  requireArray(envelope.signals, 'signal-envelope.signals');
  asRecord(envelope.baselineIdentity, 'signal-envelope.baselineIdentity');
}

function validateCommandOutcome(value, runtime) {
  const outcome = asRecord(value, 'command-outcome fixture');
  requireString(outcome.kind, 'command-outcome.kind');
  assertCondition(['ok', 'error', 'partial'].includes(outcome.status), 'invalid outcome status');
  assertCondition(typeof outcome.exitCode === 'number', 'command-outcome.exitCode must be numeric');
  if (outcome.envelope !== undefined) {
    validateSignalEnvelope(outcome.envelope, runtime.contracts.SIGNAL_ENVELOPE_SCHEMA_VERSION);
  }
  assertCondition(
    outcome.data !== undefined || outcome.envelope !== undefined || outcome.errors !== undefined,
    'command outcome must carry data, envelope, or errors',
  );
}

function validateSignalBatch(value, expectedVersion) {
  const batch = asRecord(value, 'signal-batch fixture');
  assertEqual(batch.schemaVersion, expectedVersion, 'signal batch schemaVersion mismatch');
  requireString(batch.tool, 'signal-batch.tool');
  asRecord(batch.repo, 'signal-batch.repo');
  requireString(batch.runId, 'signal-batch.runId');
  requireString(batch.createdAt, 'signal-batch.createdAt');
  asRecord(batch.counts, 'signal-batch.counts');
  requireArray(batch.signals, 'signal-batch.signals');
}

function parseArgs(argv) {
  const out = {
    configPath: DEFAULT_CONFIG,
    out: undefined,
    check: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--': {
        break;
      }
      case '--config': {
        out.configPath = requireValue(argv, ++index, arg);
        break;
      }
      case '--out': {
        out.out = requireValue(argv, ++index, arg);
        break;
      }
      case '--check': {
        out.check = true;
        break;
      }
      case '--help': {
        printHelp();
        out.help = true;
        break;
      }
      default: {
        throw new Error(`Unknown option ${arg}.`);
      }
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/compatibility-matrix.mjs [options]

Options:
  --config <path>  Compatibility matrix config (default: ${DEFAULT_CONFIG})
  --out <path>     Write a JSON report to the provided path
  --check          Mark report as CI/check mode
  --help           Show this help
`);
}

function printSummary(report, outPath, deps) {
  const log = deps.consoleLog ?? console.log;
  log(`Compatibility matrix verdict: ${report.verdict}`);
  log(`Checks: ${String(report.counts.pass)} passed, ${String(report.counts.fail)} failed`);
  if (outPath !== null) log(`Report: ${outPath}`);
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function asRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCompatibilityMatrix().then(
    ({ exitCode }) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
