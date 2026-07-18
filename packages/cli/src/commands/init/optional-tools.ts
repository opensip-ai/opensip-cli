import { selectAvailableAdapters } from '../tools/available.js';

import type { FirstPartyAdapter } from '../tools/first-party-adapters.generated.js';
import type { InitOptionalToolRecommendation, InitResult } from '@opensip-cli/contracts';

interface OptionalToolRecommendationOptions {
  readonly installedIds: ReadonlySet<string>;
  readonly catalog?: readonly FirstPartyAdapter[];
}

type EligibleInitResult = InitResult & {
  readonly created: true;
  readonly state: 'pristine';
  readonly languages: NonNullable<InitResult['languages']>;
};

const OPTIONAL_TOOL_ADOPTION_SUCCESSES = new Set([
  'not-found',
  'promoted',
  'already-project',
  'deduplicated',
  'kept-project',
]);

/** Recommendations belong only to a newly-created pristine, language-qualified project. */
export function isOptionalToolRecommendationEligible(
  result: InitResult,
): result is EligibleInitResult {
  return (
    result.created === true &&
    result.state === 'pristine' &&
    result.languages !== undefined &&
    result.languages.length > 0 &&
    (result.runtimeAdoption === undefined ||
      OPTIONAL_TOOL_ADOPTION_SUCCESSES.has(result.runtimeAdoption.status))
  );
}

function recommendation(
  row: ReturnType<typeof selectAvailableAdapters>[number],
): InitOptionalToolRecommendation {
  const installCommand = `opensip tools install ${row.pkg}`;
  return {
    id: row.id,
    pkg: row.pkg,
    network: row.network,
    languages: row.languages,
    installCommand,
    projectInstallCommand: `${installCommand} --project`,
  };
}

/** Attach a stable catalog projection without mutating or installing anything. */
export function attachOptionalToolRecommendations(
  result: InitResult,
  options: OptionalToolRecommendationOptions,
): InitResult {
  if (!isOptionalToolRecommendationEligible(result)) return result;
  const optionalTools = selectAvailableAdapters({
    languages: new Set(result.languages),
    installedIds: options.installedIds,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  })
    .filter((row) => !row.installed)
    .map(recommendation);
  return optionalTools.length === 0 ? result : { ...result, optionalTools };
}
