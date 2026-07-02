import { MIN_SUPPORTED_PLUGIN_API_VERSION, PLUGIN_API_VERSION } from '../tools/manifest.js';

import { CLI_SUPPORTED_SCHEMA_VERSION } from './config-version.js';

export type CompatibilityContractClass =
  | 'cli-command-surface'
  | 'project-config'
  | 'public-json'
  | 'tool-plugin-api'
  | 'cloud-wire'
  | 'release-artifact'
  | 'datastore-payload';

export type CompatibilityStability = 'stable' | 'epoch' | 'schema-versioned' | 'policy-only';

export interface CompatibilityContractPolicy {
  readonly class: CompatibilityContractClass;
  readonly version: number;
  readonly ownerPackage: string;
  readonly stability: CompatibilityStability;
  readonly deprecationWindow: string;
  readonly breakingChangeRequires: readonly string[];
  readonly docsPath: string;
}

export const PUBLIC_JSON_CONTRACT_VERSION = 2 as const;
export const CLOUD_WIRE_CONTRACT_VERSION = 1 as const;
export const RELEASE_ARTIFACT_CONTRACT_VERSION = 1 as const;
export const CLI_COMMAND_SURFACE_CONTRACT_VERSION = 1 as const;
export const DATASTORE_PAYLOAD_CONTRACT_VERSION = 1 as const;

export const COMPATIBILITY_CONTRACT_CLASSES: readonly CompatibilityContractClass[] = [
  'cli-command-surface',
  'project-config',
  'public-json',
  'tool-plugin-api',
  'cloud-wire',
  'release-artifact',
  'datastore-payload',
];

export const COMPATIBILITY_POLICIES: readonly CompatibilityContractPolicy[] = [
  {
    class: 'cli-command-surface',
    version: CLI_COMMAND_SURFACE_CONTRACT_VERSION,
    ownerPackage: 'opensip-cli',
    stability: 'policy-only',
    deprecationWindow: 'one minor release after GA for removals or semantic flag changes',
    breakingChangeRequires: [
      'command-surface snapshot update',
      'release note',
      'compatibility policy review',
    ],
    docsPath: 'docs/public/70-reference/01-cli-commands.md',
  },
  {
    class: 'project-config',
    version: CLI_SUPPORTED_SCHEMA_VERSION,
    ownerPackage: '@opensip-cli/config',
    stability: 'schema-versioned',
    deprecationWindow: 'migration command must exist before a breaking schema bump ships',
    breakingChangeRequires: [
      'CLI_SUPPORTED_SCHEMA_VERSION bump',
      'config migration',
      'config migration tests',
      'configuration docs update',
    ],
    docsPath: 'docs/public/70-reference/03-configuration.md',
  },
  {
    class: 'public-json',
    version: PUBLIC_JSON_CONTRACT_VERSION,
    ownerPackage: '@opensip-cli/contracts',
    stability: 'schema-versioned',
    deprecationWindow: 'one output schema version; optional fields are additive',
    breakingChangeRequires: [
      'schemaVersion bump',
      'compatibility fixture update',
      'JSON output docs update',
    ],
    docsPath: 'docs/public/70-reference/04-json-output-schema.md',
  },
  {
    class: 'tool-plugin-api',
    version: PLUGIN_API_VERSION,
    ownerPackage: '@opensip-cli/core',
    stability: 'epoch',
    deprecationWindow: `supported plugin API range ${MIN_SUPPORTED_PLUGIN_API_VERSION}..${PLUGIN_API_VERSION}`,
    breakingChangeRequires: [
      'PLUGIN_API_VERSION bump',
      'MIN_SUPPORTED_PLUGIN_API_VERSION policy review',
      'tool authoring docs update',
    ],
    docsPath: 'docs/public/50-extend/06-full-tool-plugins.md',
  },
  {
    class: 'cloud-wire',
    version: CLOUD_WIRE_CONTRACT_VERSION,
    ownerPackage: '@opensip-cli/core',
    stability: 'schema-versioned',
    deprecationWindow: 'one wire schema version coordinated with the receiving endpoint',
    breakingChangeRequires: [
      'SignalBatch schemaVersion bump',
      'cloud wire fixture update',
      'Cloud signal-sync docs update',
    ],
    docsPath: 'docs/public/10-concepts/06-cloud-signal-sync.md',
  },
  {
    class: 'release-artifact',
    version: RELEASE_ARTIFACT_CONTRACT_VERSION,
    ownerPackage: '@opensip-cli/root',
    stability: 'schema-versioned',
    deprecationWindow: 'release manifest major version in artifact filename',
    breakingChangeRequires: [
      'release manifest filename/version bump',
      'artifact verifier update',
      'release verification docs update',
    ],
    docsPath: 'docs/public/70-reference/13-verifiable-releases.md',
  },
  {
    class: 'datastore-payload',
    version: DATASTORE_PAYLOAD_CONTRACT_VERSION,
    ownerPackage: '@opensip-cli/datastore',
    stability: 'policy-only',
    deprecationWindow: 'optional absent-field defaults for payload additions',
    breakingChangeRequires: [
      'datastore migration or documented drop-and-recapture path',
      'round-trip tests',
      'session/persistence docs update',
    ],
    docsPath: 'docs/public/80-implementation/03-session-and-persistence.md',
  },
];

export function findCompatibilityPolicy(
  className: CompatibilityContractClass,
): CompatibilityContractPolicy | undefined {
  return COMPATIBILITY_POLICIES.find((policy) => policy.class === className);
}

/** @throws {Error} When the compatibility policy registry is incomplete or inconsistent. */
export function assertCompatibilityPoliciesComplete(): void {
  const classes = new Set(COMPATIBILITY_CONTRACT_CLASSES);
  const seen = new Set<CompatibilityContractClass>();
  for (const policy of COMPATIBILITY_POLICIES) {
    if (!classes.has(policy.class)) {
      throw new Error(`Unknown compatibility contract class: ${policy.class}`);
    }
    if (seen.has(policy.class)) {
      throw new Error(`Duplicate compatibility policy for ${policy.class}`);
    }
    seen.add(policy.class);
    if (policy.breakingChangeRequires.length === 0) {
      throw new Error(`Compatibility policy for ${policy.class} has no breaking-change gate.`);
    }
    if (policy.docsPath.length === 0) {
      throw new Error(`Compatibility policy for ${policy.class} has no docs path.`);
    }
  }
  const missing = [...classes].filter((className) => !seen.has(className));
  if (missing.length > 0) {
    throw new Error(`Missing compatibility policies: ${missing.join(', ')}`);
  }
}
