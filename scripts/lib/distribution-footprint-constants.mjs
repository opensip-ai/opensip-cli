export const DISTRIBUTION_FOOTPRINT_SCHEMA_VERSION = 1;
export const DISTRIBUTION_MEASURE_DEFAULT_REPEATS = 20;
export const DISTRIBUTION_MEASURE_MAX_REPEATS = 100;
export const DISTRIBUTION_TREE_MAX_ENTRIES = 1_000_000;
export const DISTRIBUTION_TREE_MAX_DEPTH = 64;
export const DISTRIBUTION_DEPENDENCY_LIST_MAX_BYTES = 16 * 1024 * 1024;
export const DISTRIBUTION_TARBALL_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
export const DISTRIBUTION_RELEASE_SET_MAX_COMPRESSED_BYTES = 512 * 1024 * 1024;
export const DISTRIBUTION_CHILD_TAIL_MAX_BYTES = 64 * 1024;
export const DISTRIBUTION_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const DISTRIBUTION_COMMAND_TIMEOUT_MS = 30 * 1000;
export const DISTRIBUTION_FOOTPRINT_DEFAULT_OUTPUT =
  '.opensip-distribution/distribution-footprint-report.json';

export const DISTRIBUTION_LANGUAGE_FAMILIES = Object.freeze([
  'typescript',
  'rust',
  'python',
  'go',
  'java',
  'cpp',
]);

export const DISTRIBUTION_FOOTPRINT_CAVEATS = Object.freeze([
  'Language-family attribution is not projected slim-install savings; shared transitive dependencies are not subtractable.',
  'Fresh-process startup exercises the current full host-wired language set.',
  'The package-manager store and this report are measurement inputs and artifacts, not a deployable offline distribution.',
  "Package-manager lifecycle behavior runs with the current user's authority and is not sandboxed.",
  'The loopback sentinel observes package-manager and cooperating lifecycle traffic during the bounded run; it cannot prove containment of direct networking or deliberately detached processes.',
]);

export const DISTRIBUTION_MEASURE_USAGE = [
  'usage: node scripts/measure-distribution-footprint.mjs --dir <artifact-dir>',
  '       --expected-version <version> [--out <report-path>] [--repeats <1-100>]',
  '       [--mode offline-cache --store-dir <prewarmed-store>]',
  '       [--mode registry-cold --registry <origin> --allow-registry]',
].join('\n');

export const DISTRIBUTION_INSTALL_MODES = Object.freeze(['offline-cache', 'registry-cold']);
export const DISTRIBUTION_STARTUP_SCENARIOS = Object.freeze(['version', 'help', 'initHelp']);
export const DISTRIBUTION_FAMILY_PACKAGE_KINDS = Object.freeze(['lang', 'checks', 'graph']);
export const DISTRIBUTION_MAX_DEPENDENCY_ROWS = 100_000;
export const DISTRIBUTION_MAX_CAVEATS = 64;
export const DISTRIBUTION_MAX_STRING_LENGTH = 4096;
