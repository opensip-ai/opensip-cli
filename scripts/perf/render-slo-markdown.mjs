import { budgetKey } from './slo-config.mjs';

export function renderTierTable(config) {
  const rows = [
    '| Tier | Max files | Max LOC | Default corpus files | Quick corpus files |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const [tier, entry] of Object.entries(config.tiers)) {
    rows.push(
      `| ${tier} | ${formatInteger(entry.maxFiles)} | ${formatInteger(entry.maxLoc)} | ` +
        `${formatInteger(entry.fileCount)} | ${formatInteger(entry.quickFileCount)} |`,
    );
  }
  return `${rows.join('\n')}\n`;
}

export function renderBudgetTable(config) {
  const rows = ['| Tier | Scenario | Duration budget | RSS budget |', '|---|---|---:|---:|'];
  for (const tier of Object.keys(config.tiers)) {
    for (const [scenario, scenarioConfig] of Object.entries(config.scenarios)) {
      const budget = config.budgetByKey.get(budgetKey(tier, scenario));
      if (budget === undefined) {
        rows.push(
          `| ${tier} | ${scenarioConfig.label ?? scenario} | Not budgeted | Not budgeted |`,
        );
        continue;
      }
      rows.push(
        `| ${tier} | ${scenarioConfig.label ?? scenario} | ${formatDuration(budget.maxDurationMs)} | ` +
          `${formatBytes(budget.maxRssBytes)} |`,
      );
    }
  }
  return `${rows.join('\n')}\n`;
}

export function replaceMarkedSection(content, marker, replacement) {
  const start = `<!-- opensip:${marker} start -->`;
  const end = `<!-- opensip:${marker} end -->`;
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Missing generated-doc markers for ${marker}.`);
  }
  return `${content.slice(0, startIndex + start.length)}\n${replacement.trimEnd()}\n${content.slice(endIndex)}`;
}

export function formatDuration(ms) {
  if (ms >= 1000) {
    const seconds = ms / 1000;
    return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
  }
  return `${String(ms)} ms`;
}

export function formatBytes(bytes) {
  const gib = bytes / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib % 1 === 0 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
  const mib = bytes / 1024 / 1024;
  return `${mib % 1 === 0 ? mib.toFixed(0) : mib.toFixed(1)} MiB`;
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US').format(value);
}
