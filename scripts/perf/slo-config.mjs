import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function budgetKey(tier, scenario) {
  return `${tier}:${scenario}`;
}

export async function loadSloConfig(configPath = '.config/performance-slos.json') {
  const absolutePath = resolve(configPath);
  const parsed = JSON.parse(await readFile(absolutePath, 'utf8'));
  return normalizeSloConfig(parsed, absolutePath);
}

export function normalizeSloConfig(raw, sourcePath = '<memory>') {
  if (!isRecord(raw))
    throw new Error(`Invalid SLO config at ${sourcePath}: root must be an object.`);
  if (raw.version !== 1) throw new Error(`Invalid SLO config at ${sourcePath}: version must be 1.`);

  const sampleIntervalMs = positiveInteger(raw.sampleIntervalMs, 'sampleIntervalMs');
  const tailBytes = normalizeTailBytes(raw.tailBytes);
  const scenarios = normalizeRecord(raw.scenarios, 'scenarios');
  const tiers = normalizeRecord(raw.tiers, 'tiers');
  const profiles = normalizeRecord(raw.profiles, 'profiles');
  const budgets = normalizeBudgetList(raw.budgets, tiers, scenarios);

  return {
    version: 1,
    sourcePath,
    sampleIntervalMs,
    tailBytes,
    scenarios,
    tiers,
    profiles: normalizeProfiles(profiles, tiers, scenarios),
    budgets,
    budgetByKey: new Map(
      budgets.map((budget) => [budgetKey(budget.tier, budget.scenario), budget]),
    ),
  };
}

function normalizeRecord(value, name) {
  if (!isRecord(value)) throw new Error(`Invalid SLO config: ${name} must be an object.`);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (!isRecord(entry))
        throw new Error(`Invalid SLO config: ${name}.${key} must be an object.`);
      return [key, { ...entry }];
    }),
  );
}

function normalizeTailBytes(value) {
  if (!isRecord(value)) throw new Error('Invalid SLO config: tailBytes must be an object.');
  return {
    stdout: positiveInteger(value.stdout, 'tailBytes.stdout'),
    stderr: positiveInteger(value.stderr, 'tailBytes.stderr'),
  };
}

function normalizeProfiles(profiles, tiers, scenarios) {
  return Object.fromEntries(
    Object.entries(profiles).map(([profileId, profile]) => {
      const tierIds = stringArray(profile.tiers, `profiles.${profileId}.tiers`);
      const scenarioIds = stringArray(profile.scenarios, `profiles.${profileId}.scenarios`);
      for (const tier of tierIds) {
        if (tiers[tier] === undefined)
          throw new Error(`Invalid SLO profile ${profileId}: unknown tier ${tier}.`);
      }
      for (const scenario of scenarioIds) {
        if (scenarios[scenario] === undefined) {
          throw new Error(`Invalid SLO profile ${profileId}: unknown scenario ${scenario}.`);
        }
      }
      return [
        profileId,
        {
          description: typeof profile.description === 'string' ? profile.description : '',
          tiers: tierIds,
          scenarios: scenarioIds,
        },
      ];
    }),
  );
}

function normalizeBudgetList(value, tiers, scenarios) {
  if (!Array.isArray(value)) throw new Error('Invalid SLO config: budgets must be an array.');
  const seen = new Set();
  return value.map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`Invalid SLO config: budgets[${index}] must be an object.`);
    const tier = stringValue(entry.tier, `budgets[${index}].tier`);
    const scenario = stringValue(entry.scenario, `budgets[${index}].scenario`);
    if (tiers[tier] === undefined)
      throw new Error(`Invalid SLO budget ${index}: unknown tier ${tier}.`);
    if (scenarios[scenario] === undefined) {
      throw new Error(`Invalid SLO budget ${index}: unknown scenario ${scenario}.`);
    }
    const key = budgetKey(tier, scenario);
    if (seen.has(key)) throw new Error(`Invalid SLO config: duplicate budget ${key}.`);
    seen.add(key);
    return {
      tier,
      scenario,
      maxDurationMs: positiveInteger(entry.maxDurationMs, `budgets[${index}].maxDurationMs`),
      maxRssBytes: positiveInteger(entry.maxRssBytes, `budgets[${index}].maxRssBytes`),
    };
  });
}

function stringArray(value, name) {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new Error(`Invalid SLO config: ${name} must be a non-empty string array.`);
  }
  if (value.length === 0) throw new Error(`Invalid SLO config: ${name} must not be empty.`);
  return [...value];
}

function stringValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid SLO config: ${name} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid SLO config: ${name} must be a positive integer.`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
