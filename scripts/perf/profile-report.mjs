import { relative } from 'node:path';

import { median, nearestRankPercentile } from './statistics.mjs';

export function createProfileReport(input) {
  return {
    version: 1,
    kind: 'opensip-performance-profile',
    createdAt: new Date().toISOString(),
    measurementMode: input.measurementMode,
    otlpExport: input.otlpExport === true,
    profile: input.profile,
    quick: input.quick,
    runs: input.runs,
    repoRoot: input.repoRoot,
    environment: input.environment,
    config: {
      sourcePath: relative(input.repoRoot, input.config.sourcePath),
      fingerprint: input.config.fingerprint,
      sampleIntervalMs: input.config.sampleIntervalMs,
      tailBytes: input.config.tailBytes,
    },
    corpora: [],
    scenarios: [],
    scenarioSummaries: [],
    verdict: 'pending',
  };
}

export function finalizeProfileReport(report) {
  const grouped = new Map();
  for (const sample of report.scenarios) {
    const key = `${sample.tier}:${sample.scenario}`;
    const samples = grouped.get(key) ?? [];
    samples.push(sample);
    grouped.set(key, samples);
  }
  report.scenarioSummaries = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map((entry) => summarizeScenarioSamples(entry[1]));
  report.verdict = report.scenarioSummaries.some((summary) => summary.failedSamples > 0)
    ? 'fail'
    : 'pass';
  return report;
}

export function summarizeScenarioSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError('scenario samples must be a non-empty array');
  }
  const successful = samples.filter(
    (sample) =>
      sample.status === 0 &&
      sample.timedOut !== true &&
      sample.skipped !== true &&
      sample.profileArtifactFailure !== true,
  );
  const first = samples[0];
  return {
    tier: first.tier,
    scenario: first.scenario,
    label: first.label,
    sampleCount: samples.length,
    failedSamples: samples.length - successful.length,
    durationMs: summarizeMetric(successful.map((sample) => sample.durationMs)),
    maxRssBytes: summarizeMetric(
      successful.map((sample) => sample.maxRssBytes),
      { includeMax: true },
    ),
    graphProfile: summarizeGraphProfiles(successful.map((sample) => sample.graphProfile)),
    startupDiagnostics: summarizeStartupDiagnostics(
      successful.map((sample) => sample.startupDiagnostics),
    ),
  };
}

export function renderProfileMarkdown(report) {
  const lines = [
    '# OpenSIP local performance profile',
    '',
    `- Measurement mode: ${report.measurementMode}`,
    `- Profile: ${report.profile}`,
    `- Repeats: ${String(report.runs)}`,
    `- Node: ${report.environment.node}`,
    `- Git: ${report.environment.gitSha ?? 'unavailable'}`,
    `- Verdict: ${report.verdict}`,
    '',
    '| Tier / scenario | Samples | Failed | Duration median | Duration p95 | RSS median | RSS max |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const summary of report.scenarioSummaries) {
    lines.push(
      `| ${summary.tier} / ${summary.scenario} | ${String(summary.sampleCount)} | ` +
        `${String(summary.failedSamples)} | ${formatDuration(summary.durationMs?.median)} | ` +
        `${formatDuration(summary.durationMs?.p95)} | ${formatBytes(summary.maxRssBytes?.median)} | ` +
        `${formatBytes(summary.maxRssBytes?.max)} |`,
    );
  }
  const hotspotRows = rankedHotspotRows(report.scenarioSummaries);
  if (hotspotRows.length > 0) {
    lines.push(
      '',
      '## Ranked hotspot evidence',
      '',
      '| Tier / scenario | Source | Stage | Median | Share of scenario |',
      '|---|---|---|---:|---:|',
    );
    for (const row of hotspotRows.slice(0, 25)) {
      lines.push(
        `| ${row.tier} / ${row.scenario} | ${row.source} | ${row.stage} | ` +
          `${formatDuration(row.durationMs)} | ${formatPercent(row.share)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function rankedHotspotRows(summaries) {
  const rows = [];
  for (const summary of summaries) {
    const total = summary.durationMs?.median;
    for (const stage of summary.graphProfile?.stages ?? []) {
      addHotspotRow(rows, summary, 'graph', stage.name, stage.durationMs?.median, total);
    }
    for (const source of ['startup', 'preAction']) {
      for (const phase of summary.startupDiagnostics?.[source]?.phases ?? []) {
        addHotspotRow(rows, summary, source, phase.phase, phase.durationMs?.median, total);
      }
    }
  }
  return rows.sort(
    (left, right) =>
      right.durationMs - left.durationMs ||
      `${left.tier}:${left.scenario}:${left.source}:${left.stage}`.localeCompare(
        `${right.tier}:${right.scenario}:${right.source}:${right.stage}`,
      ),
  );
}

function addHotspotRow(rows, summary, source, stage, durationMs, total) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return;
  rows.push({
    tier: summary.tier,
    scenario: summary.scenario,
    source,
    stage,
    durationMs,
    share:
      typeof total === 'number' && total > 0
        ? Math.min(100, (durationMs / total) * 100)
        : undefined,
  });
}

function summarizeMetric(values, options = {}) {
  const valid = values.filter(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );
  if (valid.length === 0) return;
  return {
    min: Math.min(...valid),
    median: median(valid),
    p95: nearestRankPercentile(valid, 95),
    ...(options.includeMax === true ? { max: Math.max(...valid) } : {}),
  };
}

function summarizeGraphProfiles(profiles) {
  const values = new Map();
  for (const profile of profiles) {
    if (!Array.isArray(profile?.stages)) continue;
    for (const stage of profile.stages) {
      if (typeof stage?.name !== 'string') continue;
      const samples = values.get(stage.name) ?? [];
      if (
        typeof stage.durationMs === 'number' &&
        Number.isFinite(stage.durationMs) &&
        stage.durationMs >= 0
      ) {
        samples.push(stage.durationMs);
        values.set(stage.name, samples);
      }
    }
  }
  if (values.size === 0) return;
  return {
    stages: [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, samples]) => ({
        name,
        durationMs: summarizeMetric(samples),
      })),
  };
}

function summarizeStartupDiagnostics(diagnostics) {
  const startup = summarizeDiagnosticSource(diagnostics, 'startup');
  const preAction = summarizeDiagnosticSource(diagnostics, 'preAction');
  if (startup === undefined && preAction === undefined) return;
  return { startup, preAction };
}

function summarizeDiagnosticSource(diagnostics, source) {
  const elapsed = [];
  const phases = new Map();
  for (const diagnostic of diagnostics) {
    const entry = diagnostic?.[source];
    if (typeof entry?.elapsedMs === 'number') elapsed.push(entry.elapsedMs);
    if (!Array.isArray(entry?.phases)) continue;
    for (const phase of entry.phases) {
      if (typeof phase?.phase !== 'string' || typeof phase.durationMs !== 'number') continue;
      const values = phases.get(phase.phase) ?? [];
      values.push(phase.durationMs);
      phases.set(phase.phase, values);
    }
  }
  if (elapsed.length === 0 && phases.size === 0) return;
  return {
    elapsedMs: summarizeMetric(elapsed),
    phases: [...phases.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([phase, values]) => ({
        phase,
        durationMs: summarizeMetric(values),
      })),
  };
}

function formatDuration(value) {
  if (value === undefined) return 'not measured';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

function formatBytes(value) {
  if (value === undefined) return 'not measured';
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatPercent(value) {
  return value === undefined ? 'not measured' : `${value.toFixed(1)}%`;
}
