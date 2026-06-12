/**
 * The `fitness:` block fitness contributes to the scaffolded
 * `opensip-tools.config.yml` (ADR-0038, Tool.scaffoldConfigBlock).
 *
 * Relocated verbatim from the CLI's `config-templates.ts` (the legacy
 * `fitnessBlock` literal). The CLI's `generateConfig` keeps rendering the
 * document header + `targets:` (host-owned, ADR-0023 §schema), and appends
 * each tool's `scaffoldConfigBlock()` — fitness owns its own block bytes.
 *
 * Why a string literal rather than rendering from `fitnessConfigDeclaration.defaults`:
 * the block carries inline guidance comments (`# fail if total errors >= this …`)
 * that the bare defaults object cannot express. ADR-0038 Decision 2 reserved the
 * `scaffoldConfigBlock` escape hatch for exactly this; the byte-exact init golden
 * forces it.
 */
export function fitScaffoldConfigBlock(): string {
  return [
    '',
    '# =============================================================================',
    '# Fitness configuration',
    '# =============================================================================',
    '',
    'fitness:',
    '  failOnErrors: 1     # fail if total errors >= this (0 = never fail on errors)',
    '  failOnWarnings: 0   # fail if total warnings >= this (0 = warnings are informational)',
    '  disabledChecks: []',
    '',
  ].join('\n');
}
