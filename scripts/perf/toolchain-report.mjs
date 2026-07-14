import { median, nearestRankPercentile } from './statistics.mjs';

export const TOOLCHAIN_REPORT_VERSION = 1;

/** Build the machine-readable report for one fixed workspace-toolchain benchmark. */
export function createToolchainReport(input) {
  const scenarios = normalizeScenarios(input.scenarios);
  const repetitions = positiveSafeInteger(input.repetitions, 'repetitions');
  if (scenarios.some((scenario) => scenario.samples.length !== repetitions)) {
    throw new Error('every toolchain scenario must contain exactly one sample per repetition');
  }

  const cache = normalizeCache(input.cacheMode);
  const typescript = normalizeTypescript(input.typescript);
  return {
    version: TOOLCHAIN_REPORT_VERSION,
    kind: 'opensip-toolchain-benchmark',
    createdAt: requiredString(input.createdAt, 'createdAt'),
    profile: 'toolchain',
    measurementMode: 'toolchain-throughput',
    evidenceScope: 'developer-and-ci-toolchain-throughput',
    runtimeClaim: false,
    repetitions,
    iterationOrder: scenarios.map((scenario) => scenario.scenario),
    cache,
    environment: {
      ...normalizeEnvironment(input.environment),
      typescript: typescript.resolved,
      typescriptDeclared: typescript.declared,
    },
    scenarios,
  };
}

/** Summarize non-negative millisecond samples without mutating the input. */
export function summarizeDurations(values) {
  const samples = normalizedDurations(values);
  return {
    min: Math.min(...samples),
    median: median(samples),
    p95: nearestRankPercentile(samples, 95),
  };
}

/** Render a compact, PR-friendly view of a toolchain report. */
export function renderToolchainMarkdown(report) {
  const environment = report.environment;
  const lines = [
    '# OpenSIP toolchain benchmark',
    '',
    '> Developer/CI toolchain throughput only; these timings do not measure built CLI runtime.',
    '',
    `- Created: ${markdownText(report.createdAt)}`,
    `- Toolchain: TypeScript ${markdownText(environment.typescript)} (declared ${markdownText(environment.typescriptDeclared)}), Node ${markdownText(environment.node)}, pnpm ${markdownText(environment.pnpm)}`,
    `- Host: ${markdownText(environment.platform)} ${markdownText(environment.release)} / ${markdownText(environment.arch)}, ${markdownText(environment.cpuModel)} (${String(environment.cpuCount)} logical CPUs)`,
    `- Git: ${markdownText(environment.gitBranch)} @ ${markdownText(environment.gitSha)}`,
    `- Cache: ${markdownText(report.cache.mode)} — ${markdownText(report.cache.description)}`,
    `- Repetitions: ${String(report.repetitions)} (fixed iteration order: ${report.iterationOrder.map((value) => markdownCode(value)).join(', ')})`,
    '',
    '| Scenario | Command | min | median | p95 |',
    '|---|---|---:|---:|---:|',
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${markdownText(scenario.label)} | ${markdownCode(scenario.command.join(' '))} | ${formatMilliseconds(scenario.summary.durationMs.min)} | ${formatMilliseconds(scenario.summary.durationMs.median)} | ${formatMilliseconds(scenario.summary.durationMs.p95)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function normalizeScenarios(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('scenarios must be a non-empty array');
  }
  const seen = new Set();
  return value.map((scenario, index) => {
    if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) {
      throw new TypeError(`scenarios[${String(index)}] must be an object`);
    }
    const id = requiredString(scenario.scenario, `scenarios[${String(index)}].scenario`);
    if (seen.has(id)) throw new Error(`duplicate toolchain scenario '${id}'`);
    seen.add(id);
    if (!Array.isArray(scenario.command) || scenario.command.length === 0) {
      throw new TypeError(`scenarios[${String(index)}].command must be a non-empty array`);
    }
    const command = scenario.command.map((part, partIndex) =>
      requiredString(part, `scenarios[${String(index)}].command[${String(partIndex)}]`),
    );
    const samples = normalizeSamples(scenario.samples, index);
    const durationMs = summarizeDurations(samples.map((sample) => sample.durationMs));
    const rssValues = samples
      .map((sample) => sample.maxRssBytes)
      .filter((sample) => sample !== undefined);
    return {
      tier: 'workspace',
      scenario: id,
      label: requiredString(scenario.label, `scenarios[${String(index)}].label`),
      command,
      samples,
      summary: {
        durationMs,
        ...(rssValues.length === 0 ? {} : { maxRssBytes: summarizeDurations(rssValues) }),
      },
    };
  });
}

function normalizeSamples(value, scenarioIndex) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`scenarios[${String(scenarioIndex)}].samples must be a non-empty array`);
  }
  return value.map((sample, sampleIndex) => {
    if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) {
      throw new TypeError(
        `scenarios[${String(scenarioIndex)}].samples[${String(sampleIndex)}] must be an object`,
      );
    }
    const status = sample.status ?? 0;
    if (!Number.isSafeInteger(status) || status !== 0) {
      throw new Error('toolchain reports accept successful samples only');
    }
    return {
      run: positiveSafeInteger(sample.run, 'sample.run'),
      status,
      durationMs: nonNegativeFiniteNumber(sample.durationMs, 'sample.durationMs'),
      ...(sample.maxRssBytes === undefined
        ? {}
        : {
            maxRssBytes: nonNegativeFiniteNumber(sample.maxRssBytes, 'sample.maxRssBytes'),
          }),
      ...(optionalString(sample.startedAt) === undefined ? {} : { startedAt: sample.startedAt }),
      ...(optionalString(sample.completedAt) === undefined
        ? {}
        : { completedAt: sample.completedAt }),
    };
  });
}

function normalizeEnvironment(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('environment must be an object');
  }
  return {
    node: stringOrUnavailable(value.node),
    pnpm: stringOrUnavailable(value.pnpm),
    arch: stringOrUnavailable(value.arch),
    platform: stringOrUnavailable(value.platform),
    release: stringOrUnavailable(value.release),
    cpuModel: stringOrUnavailable(value.cpuModel),
    cpuCount: nonNegativeSafeInteger(value.cpuCount, 'environment.cpuCount'),
    ci: value.ci === true,
    gitSha: stringOrUnavailable(value.gitSha),
    gitBranch: stringOrUnavailable(value.gitBranch),
  };
}

function normalizeTypescript(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('typescript metadata must be an object');
  }
  return {
    declared: stringOrUnavailable(value.declared),
    resolved: stringOrUnavailable(value.resolved),
  };
}

function normalizeCache(mode) {
  if (mode === 'force') {
    return {
      mode,
      turboForce: true,
      eslintCache: false,
      description:
        'TURBO_FORCE=true; Turbo cache reads are bypassed while writes remain enabled; ESLint runs without --cache',
    };
  }
  if (mode === 'reuse') {
    return {
      mode,
      turboForce: false,
      eslintCache: false,
      description:
        'TURBO_FORCE=false; existing Turbo cache reads and writes are allowed; ESLint runs without --cache',
    };
  }
  throw new Error("cacheMode must be 'force' or 'reuse'");
}

function normalizedDurations(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('duration samples must be a non-empty array');
  }
  return values.map((value, index) =>
    nonNegativeFiniteNumber(value, `duration samples[${String(index)}]`),
  );
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringOrUnavailable(value) {
  return optionalString(value) ?? 'unavailable';
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function nonNegativeFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function markdownText(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function markdownCode(value) {
  return `<code>${markdownText(value).replaceAll('`', '&#96;')}</code>`;
}

function formatMilliseconds(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}
