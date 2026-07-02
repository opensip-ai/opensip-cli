import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const SUPPORTED_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'python',
  'go',
  'java',
  'rust',
  'cpp',
  'universal',
]);

export async function loadQualityConfig(configPath = '.config/detection-quality.json') {
  const absolutePath = resolve(configPath);
  const parsed = JSON.parse(await readFile(absolutePath, 'utf8'));
  return normalizeQualityConfig(parsed, absolutePath);
}

export function normalizeQualityConfig(raw, sourcePath = '<memory>') {
  if (!isRecord(raw))
    throw new Error(`Invalid quality config at ${sourcePath}: root must be an object.`);
  assertKnownKeys(
    raw,
    [
      'version',
      'maxFixtureBytes',
      'maxCases',
      'concurrency',
      'requiredLanguages',
      'profiles',
      'corpora',
      'thresholds',
      'commandChecks',
      'triage',
      'architectureUsefulness',
    ],
    'quality config',
  );
  if (raw.version !== 1)
    throw new Error(`Invalid quality config at ${sourcePath}: version must be 1.`);

  const corpora = normalizeCorpora(raw.corpora);
  const profiles = normalizeProfiles(raw.profiles, corpora);
  const thresholds = normalizeThresholds(raw.thresholds);
  const requiredLanguages = stringArray(raw.requiredLanguages, 'requiredLanguages');
  for (const language of requiredLanguages) assertSupportedLanguage(language, 'requiredLanguages');

  return {
    version: 1,
    sourcePath,
    maxFixtureBytes: positiveInteger(raw.maxFixtureBytes, 'maxFixtureBytes'),
    maxCases: positiveInteger(raw.maxCases, 'maxCases'),
    concurrency: positiveInteger(raw.concurrency, 'concurrency'),
    requiredLanguages,
    profiles,
    corpora,
    thresholds,
    commandChecks: normalizeCommandChecks(raw.commandChecks),
    triage: normalizeTriage(raw.triage),
    architectureUsefulness: normalizeArchitectureUsefulness(raw.architectureUsefulness),
  };
}

function normalizeCorpora(value) {
  const record = recordValue(value, 'corpora');
  return Object.fromEntries(
    Object.entries(record).map(([id, entry]) => {
      if (!isRecord(entry))
        throw new Error(`Invalid quality config: corpora.${id} must be an object.`);
      assertKnownKeys(entry, ['manifest'], `corpora.${id}`);
      return [id, { manifest: stringValue(entry.manifest, `corpora.${id}.manifest`) }];
    }),
  );
}

function normalizeProfiles(value, corpora) {
  const record = recordValue(value, 'profiles');
  return Object.fromEntries(
    Object.entries(record).map(([id, entry]) => {
      if (!isRecord(entry))
        throw new Error(`Invalid quality config: profiles.${id} must be an object.`);
      assertKnownKeys(
        entry,
        ['description', 'corpora', 'architectureUsefulness'],
        `profiles.${id}`,
      );
      const corpusIds = stringArray(entry.corpora, `profiles.${id}.corpora`);
      for (const corpusId of corpusIds) {
        if (corpora[corpusId] === undefined) {
          throw new Error(`Invalid quality profile ${id}: unknown corpus ${corpusId}.`);
        }
      }
      return [
        id,
        {
          description: typeof entry.description === 'string' ? entry.description : '',
          corpora: corpusIds,
          architectureUsefulness: entry.architectureUsefulness !== false,
        },
      ];
    }),
  );
}

function normalizeThresholds(value) {
  const input = recordValue(value, 'thresholds');
  assertKnownKeys(
    input,
    [
      'minPrecision',
      'minRecall',
      'maxFpr',
      'precisionDropTolerance',
      'recallDropTolerance',
      'fprIncreaseTolerance',
      'supportDropTolerance',
      'minArchitectureScenarios',
      'minArchitectureDecisionChangeRate',
    ],
    'thresholds',
  );
  return {
    minPrecision: rateValue(input.minPrecision, 'thresholds.minPrecision'),
    minRecall: rateValue(input.minRecall, 'thresholds.minRecall'),
    maxFpr: rateValue(input.maxFpr, 'thresholds.maxFpr'),
    precisionDropTolerance: rateValue(
      input.precisionDropTolerance,
      'thresholds.precisionDropTolerance',
    ),
    recallDropTolerance: rateValue(input.recallDropTolerance, 'thresholds.recallDropTolerance'),
    fprIncreaseTolerance: rateValue(input.fprIncreaseTolerance, 'thresholds.fprIncreaseTolerance'),
    supportDropTolerance: nonNegativeInteger(
      input.supportDropTolerance,
      'thresholds.supportDropTolerance',
    ),
    minArchitectureScenarios: nonNegativeInteger(
      input.minArchitectureScenarios,
      'thresholds.minArchitectureScenarios',
    ),
    minArchitectureDecisionChangeRate: rateValue(
      input.minArchitectureDecisionChangeRate,
      'thresholds.minArchitectureDecisionChangeRate',
    ),
  };
}

function normalizeCommandChecks(value) {
  const input = recordValue(value, 'commandChecks');
  assertKnownKeys(input, ['allow'], 'commandChecks');
  const allow = recordValue(input.allow, 'commandChecks.allow');
  for (const [slug, reason] of Object.entries(allow)) {
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new Error(
        `Invalid quality config: commandChecks.allow.${slug} must be a non-empty reason.`,
      );
    }
  }
  return { allow: { ...allow } };
}

function normalizeTriage(value) {
  const input = recordValue(value, 'triage');
  assertKnownKeys(
    input,
    [
      'maxQualityRows',
      'suppressionMultiplier',
      'fprWeight',
      'recallGapWeight',
      'precisionGapWeight',
    ],
    'triage',
  );
  return {
    maxQualityRows: positiveInteger(input.maxQualityRows, 'triage.maxQualityRows'),
    suppressionMultiplier: nonNegativeNumber(
      input.suppressionMultiplier,
      'triage.suppressionMultiplier',
    ),
    fprWeight: nonNegativeNumber(input.fprWeight, 'triage.fprWeight'),
    recallGapWeight: nonNegativeNumber(input.recallGapWeight, 'triage.recallGapWeight'),
    precisionGapWeight: nonNegativeNumber(input.precisionGapWeight, 'triage.precisionGapWeight'),
  };
}

function normalizeArchitectureUsefulness(value) {
  const input = recordValue(value, 'architectureUsefulness');
  assertKnownKeys(input, ['scenarios'], 'architectureUsefulness');
  if (!Array.isArray(input.scenarios)) {
    throw new TypeError(
      'Invalid quality config: architectureUsefulness.scenarios must be an array.',
    );
  }
  const seen = new Set();
  return {
    scenarios: input.scenarios.map((scenario, index) => {
      if (!isRecord(scenario)) {
        throw new TypeError(
          `Invalid quality config: architectureUsefulness.scenarios[${index}] must be an object.`,
        );
      }
      assertKnownKeys(
        scenario,
        ['id', 'label', 'rawDecision', 'contextDecision', 'expected', 'rationale'],
        `architectureUsefulness.scenarios[${index}]`,
      );
      const id = stringValue(scenario.id, `architectureUsefulness.scenarios[${index}].id`);
      if (seen.has(id))
        throw new Error(`Invalid quality config: duplicate architecture scenario ${id}.`);
      seen.add(id);
      const expected = stringValue(
        scenario.expected,
        `architectureUsefulness.scenarios[${index}].expected`,
      );
      if (
        !['context_changes_decision', 'context_does_not_change_decision', 'inconclusive'].includes(
          expected,
        )
      ) {
        throw new Error(`Invalid quality config: unknown architecture expected value ${expected}.`);
      }
      return {
        id,
        label: stringValue(scenario.label, `architectureUsefulness.scenarios[${index}].label`),
        rawDecision: stringValue(
          scenario.rawDecision,
          `architectureUsefulness.scenarios[${index}].rawDecision`,
        ),
        contextDecision: stringValue(
          scenario.contextDecision,
          `architectureUsefulness.scenarios[${index}].contextDecision`,
        ),
        expected,
        rationale: stringValue(
          scenario.rationale,
          `architectureUsefulness.scenarios[${index}].rationale`,
        ),
      };
    }),
  };
}

export function assertSupportedLanguage(language, field) {
  if (!SUPPORTED_LANGUAGES.has(language)) {
    throw new Error(`Invalid quality config: ${field} uses unsupported language ${language}.`);
  }
}

function recordValue(value, name) {
  if (!isRecord(value)) throw new Error(`Invalid quality config: ${name} must be an object.`);
  return value;
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid quality config: ${name} must be a non-empty string array.`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const item = stringValue(entry, `${name}[${index}]`);
    if (seen.has(item))
      throw new Error(`Invalid quality config: ${name} contains duplicate ${item}.`);
    seen.add(item);
    return item;
  });
}

function stringValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid quality config: ${name} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid quality config: ${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid quality config: ${name} must be a non-negative integer.`);
  }
  return value;
}

function rateValue(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid quality config: ${name} must be a number between 0 and 1.`);
  }
  return value;
}

function nonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid quality config: ${name} must be a non-negative number.`);
  }
  return value;
}

function assertKnownKeys(record, keys, name) {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Invalid quality config: unknown key ${name}.${key}.`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
