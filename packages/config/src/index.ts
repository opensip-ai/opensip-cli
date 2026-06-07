/**
 * @opensip-tools/config — the capability-configuration layer.
 *
 * The configuration composer and schema registry land here in Phase 1 (adding
 * a Zod dependency). The package depends on @opensip-tools/core (errors, yaml)
 * and may re-export a contract type.
 *
 * Until the composer lands, the barrel re-exports the kernel's
 * {@link ConfigurationError} — the error every config-resolution path in this
 * layer throws on a malformed or contradictory configuration. Surfacing it from
 * the config package's own barrel means consumers `catch` against the
 * configuration layer they call, not the kernel underneath it.
 */

export { ConfigurationError } from '@opensip-tools/core';
