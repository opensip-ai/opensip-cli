const FIRST_PARTY_CHECK_PACKS = [
  ['@opensip-cli/checks-universal', 'checks-universal'],
  ['@opensip-cli/checks-typescript', 'checks-typescript'],
  ['@opensip-cli/checks-python', 'checks-python'],
  ['@opensip-cli/checks-go', 'checks-go'],
  ['@opensip-cli/checks-java', 'checks-java'],
  ['@opensip-cli/checks-rust', 'checks-rust'],
  ['@opensip-cli/checks-cpp', 'checks-cpp'],
];

export async function loadFirstPartyChecks(options = {}) {
  if (options.checks) return indexChecks(options.checks);
  const loaded = [];
  for (const [specifier, pack] of FIRST_PARTY_CHECK_PACKS) {
    let module;
    try {
      module = await import(specifier);
    } catch (error) {
      throw new Error(
        `Could not load ${specifier}. Run \`pnpm build\` or \`node scripts/build-ci.mjs\` before detection-quality measurement. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!Array.isArray(module.checks)) {
      throw new TypeError(`Check pack ${specifier} does not export a checks array.`);
    }
    for (const check of module.checks) loaded.push({ check, pack });
  }
  return indexChecks(loaded);
}

export function indexChecks(entries) {
  const bySlug = new Map();
  const skipped = [];
  for (const entry of entries) {
    const check = entry.check ?? entry;
    const pack = entry.pack ?? 'test-pack';
    const slug = check?.config?.slug;
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new TypeError('Quality check index received a check without config.slug.');
    }
    if (check.config.disabled === true) continue;
    if (bySlug.has(slug)) throw new Error(`Duplicate quality check slug ${slug}.`);
    bySlug.set(slug, { check, pack, slug });
    if (check.config.analysisMode === 'command')
      skipped.push({ slug, pack, reason: 'command-mode' });
  }
  return { bySlug, skipped };
}
