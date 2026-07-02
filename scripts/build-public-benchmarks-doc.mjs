#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import {
  formatBenchmarkBytes,
  formatBenchmarkDuration,
  formatBenchmarkInteger,
  normalizeBenchmarkSnapshot,
  rowsFromSnapshot,
  snapshotFromSloReport,
} from './benchmarks/public-benchmark-schema.mjs';
import { replaceMarkedSection } from './perf/render-slo-markdown.mjs';
import { loadSloConfig } from './perf/slo-config.mjs';

const DOC_PATH = resolve('docs/public/70-reference/12-public-benchmarks.md');
const SNAPSHOT_PATH = resolve('docs/public/70-reference/benchmark-snapshot.json');

export async function buildPublicBenchmarksDoc(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.help === true) return { changed: false };

  const read = deps.readFile ?? readFile;
  const write = deps.writeFile ?? writeFile;
  const config = await (deps.loadSloConfig ?? loadSloConfig)();
  const snapshotPath = resolve(options.snapshotPath);
  let snapshotText = await read(snapshotPath, 'utf8').catch(() => '');
  let snapshot;
  let nextSnapshotText = snapshotText;

  if (options.reportPath === undefined) {
    snapshot = normalizeBenchmarkSnapshot(JSON.parse(snapshotText), snapshotPath);
  } else {
    const report = JSON.parse(await read(resolve(options.reportPath), 'utf8'));
    snapshot = snapshotFromSloReport(report, {
      source:
        options.source ??
        `pnpm bench:slo -- --profile ${String(report.profile ?? 'pr')} --out slo-report.json`,
    });
    nextSnapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
  }

  const docPath = resolve(options.docPath);
  const originalDoc = await read(docPath, 'utf8');
  const nextDoc = renderBenchmarkDoc(originalDoc, snapshot, config);
  const snapshotChanged = nextSnapshotText !== snapshotText;
  const docChanged = nextDoc !== originalDoc;

  if (options.check === true) {
    const stale = [];
    if (snapshotChanged && options.reportPath !== undefined)
      stale.push(relative(process.cwd(), snapshotPath));
    if (docChanged) stale.push(relative(process.cwd(), docPath));
    if (stale.length > 0) {
      throw new Error(
        `Public benchmark docs are stale. Run \`pnpm docs:benchmarks\`. Stale: ${stale.join(', ')}`,
      );
    }
    return { changed: false };
  }

  if (options.reportPath !== undefined && snapshotChanged) {
    await write(snapshotPath, nextSnapshotText);
  }
  if (docChanged) {
    await write(docPath, nextDoc);
  }
  return { changed: snapshotChanged || docChanged };
}

export function renderBenchmarkDoc(content, snapshot, config) {
  let next = replaceMarkedSection(
    content,
    'public-benchmark-summary',
    renderSummaryTable(snapshot),
  );
  next = replaceMarkedSection(next, 'public-benchmark-corpora', renderCorporaTable(snapshot));
  next = replaceMarkedSection(
    next,
    'public-benchmark-results',
    renderResultsTable(snapshot, config),
  );
  next = replaceMarkedSection(
    next,
    'public-benchmark-environment',
    renderEnvironmentTable(snapshot),
  );
  return next;
}

function renderSummaryTable(snapshot) {
  const rows = [
    '| Field | Value |',
    '|---|---|',
    `| Measured at | ${snapshot.createdAt} |`,
    `| Source | \`${snapshot.source}\` |`,
    `| Profile | \`${snapshot.profile}\` |`,
    `| Quick mode | ${snapshot.quick ? 'yes' : 'no'} |`,
    `| Verdict | ${snapshot.verdict} |`,
  ];
  return `${rows.join('\n')}\n`;
}

function renderCorporaTable(snapshot) {
  const rows = ['| Tier | Generated files | Changed files | Git ready |', '|---|---:|---:|---|'];
  for (const corpus of snapshot.corpora) {
    rows.push(
      `| ${corpus.tier} | ${formatBenchmarkInteger(corpus.fileCount)} | ${formatBenchmarkInteger(
        corpus.changedFileCount,
      )} | ${corpus.gitReady ? 'yes' : 'no'} |`,
    );
  }
  return `${rows.join('\n')}\n`;
}

function renderResultsTable(snapshot, config) {
  const rows = [
    '| Tier | Scenario | Status | Duration | Duration budget | Duration margin | Peak RSS | RSS budget | RSS margin | Graph cache |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const row of rowsFromSnapshot(snapshot, config)) {
    rows.push(
      [
        `| ${row.tier}`,
        row.label,
        row.status,
        formatBenchmarkDuration(row.durationMs),
        formatBenchmarkDuration(row.durationBudgetMs),
        formatSignedDuration(row.durationMarginMs),
        formatBenchmarkBytes(row.maxRssBytes),
        formatBenchmarkBytes(row.rssBudgetBytes),
        formatSignedBytes(row.rssMarginBytes),
        row.graphCache ?? '',
      ].join(' | ') + ' |',
    );
  }
  return `${rows.join('\n')}\n`;
}

function renderEnvironmentTable(snapshot) {
  const rows = [
    '| Field | Value |',
    '|---|---|',
    `| Node.js | \`${snapshot.environment.node}\` |`,
    `| Platform | \`${snapshot.environment.platform}\` |`,
    `| OS release | \`${snapshot.environment.release}\` |`,
    `| CPU count | ${formatBenchmarkInteger(snapshot.environment.cpuCount)} |`,
    `| CI | ${snapshot.environment.ci ? 'yes' : 'no'} |`,
  ];
  return `${rows.join('\n')}\n`;
}

function formatSignedDuration(ms) {
  if (ms === undefined) return 'not measured';
  const prefix = ms >= 0 ? '+' : '-';
  return `${prefix}${formatBenchmarkDuration(Math.abs(ms))}`;
}

function formatSignedBytes(bytes) {
  if (bytes === undefined) return 'not measured';
  const prefix = bytes >= 0 ? '+' : '-';
  return `${prefix}${formatBenchmarkBytes(Math.abs(bytes))}`;
}

function parseArgs(argv) {
  const out = {
    check: false,
    snapshotPath: SNAPSHOT_PATH,
    docPath: DOC_PATH,
    reportPath: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--': {
        break;
      }
      case '--check': {
        out.check = true;
        break;
      }
      case '--snapshot': {
        out.snapshotPath = requireValue(argv, ++index, arg);
        break;
      }
      case '--doc': {
        out.docPath = requireValue(argv, ++index, arg);
        break;
      }
      case '--report': {
        out.reportPath = requireValue(argv, ++index, arg);
        break;
      }
      case '--source': {
        out.source = requireValue(argv, ++index, arg);
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

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/build-public-benchmarks-doc.mjs [options]

Options:
  --check              Fail if the benchmark docs are stale
  --snapshot <path>    Snapshot JSON path
  --doc <path>         Benchmark markdown path
  --report <path>      Refresh the snapshot from a raw SLO report before rendering
  --source <command>   Source command recorded in the normalized snapshot
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildPublicBenchmarksDoc().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
