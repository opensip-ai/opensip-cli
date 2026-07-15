import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { ConfigurationError, readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const SPOTBUGS_IDENTITY: ToolIdentity = { name: 'spotbugs' };
export const SPOTBUGS_STABLE_ID = '47a950e0-f631-4d80-aa35-02968ef97747';

/** Well-known class output directory suffixes (Maven / Gradle / IntelliJ). */
const CLASS_DIR_SUFFIXES = [
  'target/classes',
  'build/classes/java/main',
  'build/classes',
  'out/production',
] as const;

/** Bound the walk so monorepos cannot force unbounded FS scans. */
const MAX_WALK_DEPTH = 6;
const MAX_DIRS_VISITED = 400;
const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.runtime',
  'opensip-cli',
  'src',
  'test',
  'tests',
  'docs',
  'vendor',
  'dist',
]);

/**
 * Discover compiled class directories under the project root: first the well-known
 * top-level candidates, then a bounded walk for nested modules (e.g.
 * `modules/api/target/classes`).
 */
export function classTargets(projectRoot: string): readonly string[] {
  const found = new Set<string>();

  for (const candidate of CLASS_DIR_SUFFIXES) {
    const full = join(projectRoot, candidate);
    if (existsSync(full) && isDirectory(full)) found.add(full);
  }

  // Bounded BFS for nested Maven/Gradle module layouts.
  const queue: { dir: string; depth: number }[] = [{ dir: projectRoot, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_DIRS_VISITED) {
    const next = queue.shift();
    if (next === undefined) break;
    const { dir, depth } = next;
    visited += 1;
    if (depth >= MAX_WALK_DEPTH) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      // Skip VCS / tooling / source trees we never need for class discovery.
      if (name.startsWith('.') || SKIP_DIR_NAMES.has(name)) continue;
      const child = join(dir, name);
      if (!isDirectory(child)) continue;

      const rel = relative(projectRoot, child).split(sep).join('/');
      for (const suffix of CLASS_DIR_SUFFIXES) {
        if (rel === suffix || rel.endsWith(`/${suffix}`)) {
          found.add(child);
        }
      }

      queue.push({ dir: child, depth: depth + 1 });
    }
  }

  return [...found].sort();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build the CLI args for a SpotBugs scan over the project's compiled class
 * directories, writing SARIF at max effort. Throws ConfigurationError when no
 * build output is found — SpotBugs analyzes bytecode, not source.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  const targets = classTargets(ctx.projectRoot);
  if (targets.length === 0) {
    throw new ConfigurationError(
      'spotbugs requires compiled Java classes (for example target/classes or build/classes/java/main).',
      { code: 'ADAPTER.CONFIG.MISSING_BUILD_OUTPUT' },
    );
  }
  return [
    '-textui',
    '-effort:max',
    '-low',
    '-sarif',
    '-output',
    ctx.artifactPath('spotbugs.sarif'),
    ...targets,
  ];
}

export const tool: Tool = defineExternalToolAdapter({
  identity: SPOTBUGS_IDENTITY,
  metadata: {
    id: SPOTBUGS_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Java bytecode analysis via SpotBugs',
    adapterPackage: '@opensip-cli/tool-spotbugs',
  },
  binary: {
    command: 'spotbugs',
    versionArgs: ['-version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '4.8.0',
    resolution: ['config', 'path'],
    installHint: 'Install SpotBugs: https://spotbugs.github.io/ (brew install spotbugs)',
  },
  network: 'local-only',
  languages: ['java'],
  commands: [
    {
      name: 'scan',
      description: 'Analyze compiled Java classes with SpotBugs',
      args: buildScanArgs,
      output: { kind: 'sarif', path: 'spotbugs.sarif' },
      // SpotBugs' exit code is a bugs(1)|missing-class(2)|error(4) bitmask. Missing
      // referenced classes (common without a full -auxclasspath) set bit 2 but are
      // not a fault; only the error bit (>=4) is. Findings come from the SARIF file.
      exitCodes: {
        ok: [0],
        findings: [],
        findingsFromNonzero: true,
        errorFrom: 4,
      },
    },
  ],
  fingerprintStrategy: 'message-hash',
});
