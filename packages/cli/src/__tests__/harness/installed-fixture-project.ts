// @fitness-ignore-file test-file-naming -- this is a shared test HELPER (it materialises the dispatch fixture as an INSTALLED tool in a temp project), not a test file; it deliberately is not named *.test.ts.
/**
 * installed-fixture-project — materialise the external-dispatch fixture tool as a
 * genuinely INSTALLED npm tool inside a throwaway project, exactly as the worker
 * bootstrap discovers a real one (ADR-0054 M4-E).
 *
 * After the M4-E trust-tier flip, the dispatch supervisor forks the CLI binary as
 * the `__tool-command-worker` subcommand. The forked worker re-runs the FULL CLI
 * bootstrap, which DISCOVERS the dispatched tool from `node_modules` on its cwd
 * walk-up (`bootstrapCli({ cwd: process.cwd() })`) — it does NOT import the spec's
 * `toolPackageDir` directly. So a dispatch e2e test must present the fixture the
 * way a real install does:
 *
 *   <project>/opensip-cli.config.yml                                  (project marker)
 *   <project>/node_modules/@opensip-cli-fixture/external-dispatch-tool (the tool)
 *
 * plus the installed-tool trust allowlist env (`OPENSIP_CLI_ALLOW_INSTALLED_TOOLS`)
 * because installed tools are deny-by-default. The supervisor pins the forked
 * child's cwd to this project, so discovery + project resolution both anchor here.
 *
 * This keeps the dispatch suite honest: it exercises the SAME discovery/admission/
 * trust path a third-party tool takes, not a test-only shortcut.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The fixture source dir (committed under __tests__/fixtures). */
const FIXTURE_SRC = join(HERE, '..', 'fixtures', 'external-dispatch-tool');
const CORE_PACKAGE_DIR = join(HERE, '..', '..', '..', '..', 'core');

/** The installed-tool id the fixture declares (must match its manifest). */
export const FIXTURE_TOOL_ID = 'external-dispatch-tool';

/** The npm package name the fixture is installed under. */
const FIXTURE_PKG = '@opensip-cli-fixture/external-dispatch-tool';

export interface InstalledFixtureProject {
  /** The temp project root (set as the worker's cwd + `--cwd`). */
  readonly projectDir: string;
  /** The fixture's installed package dir under the project's node_modules. */
  readonly packageDir: string;
  /** File written immediately on handler entry when the sentinel option is enabled. */
  readonly handlerSentinelPath?: string;
  /** File written at module evaluation when the import sentinel is enabled. */
  readonly importSentinelPath?: string;
}

/**
 * Create a temp project with the fixture installed as a real npm tool. Caller is
 * responsible for cleanup is unnecessary — the OS temp dir is reclaimed; tests
 * create one per run and never collide (mkdtemp is unique).
 */
export function makeInstalledFixtureProject(
  options: {
    runtimeMetadataId?: string;
    handlerSentinel?: boolean;
    importSentinel?: boolean;
  } = {},
): InstalledFixtureProject {
  const projectDir = mkdtempSync(join(tmpdir(), 'opensip-m4e-dispatch-proj-'));
  // Project marker so the worker's `scope: 'project'` bootstrap resolves a
  // project (otherwise it bails "no project found" before the handler runs). A
  // comment-only document is a valid EMPTY config — no namespaces, so no
  // unclaimed-namespace warning from the composer.
  writeFileSync(
    join(projectDir, 'opensip-cli.config.yml'),
    '# minimal fixture project marker for the ADR-0054 dispatch e2e\n',
    'utf8',
  );
  const packageDir = join(projectDir, 'node_modules', FIXTURE_PKG);
  mkdirSync(packageDir, { recursive: true });
  // Copy (not symlink) so discovery's node_modules scan finds a real package dir.
  cpSync(FIXTURE_SRC, packageDir, { recursive: true });
  // A real installed Tool that imports currentScope has @opensip-cli/core
  // resolvable from its project. Link the built workspace package so this fixture
  // exercises that production shape rather than failing package resolution first.
  const coreScopeDir = join(projectDir, 'node_modules', '@opensip-cli');
  mkdirSync(coreScopeDir, { recursive: true });
  symlinkSync(CORE_PACKAGE_DIR, join(coreScopeDir, 'core'), 'junction');
  const runtimePath = join(packageDir, 'index.js');
  let source = readFileSync(runtimePath, 'utf8');
  let changed = false;
  const importSentinelPath = join(projectDir, 'runtime-imported.sentinel');
  if (options.importSentinel === true) {
    source =
      "import { writeFileSync as writeImportSentinel } from 'node:fs';\n" +
      `writeImportSentinel(${JSON.stringify(importSentinelPath)}, 'imported', 'utf8');\n` +
      source;
    changed = true;
  }
  if (options.runtimeMetadataId !== undefined) {
    const metadataIdDeclaration = "id: 'f1e2d3c4-b5a6-4789-90ab-cdef01234567'";
    if (!source.includes(metadataIdDeclaration)) {
      throw new Error('external dispatch fixture metadata id declaration was not found');
    }
    source = source.replace(
      metadataIdDeclaration,
      `id: ${JSON.stringify(options.runtimeMetadataId)}`,
    );
    changed = true;
  }

  const handlerSentinelPath = join(projectDir, 'handler-entered.sentinel');
  if (options.handlerSentinel === true) {
    const handlerStart =
      "handler: async (options, cli) => {\n        const mode = options.mode ?? 'ok';";
    if (!source.includes(handlerStart)) {
      throw new Error('external dispatch fixture handler declaration was not found');
    }
    source = source.replace(
      handlerStart,
      'handler: async (options, cli) => {\n' +
        "        const { writeFileSync: writeHandlerSentinel } = await import('node:fs');\n" +
        `        writeHandlerSentinel(${JSON.stringify(handlerSentinelPath)}, 'entered', 'utf8');\n` +
        "        const mode = options.mode ?? 'ok';",
    );
    changed = true;
  }
  if (changed) writeFileSync(runtimePath, source, 'utf8');

  return {
    projectDir,
    packageDir,
    ...(options.handlerSentinel === true ? { handlerSentinelPath } : {}),
    ...(options.importSentinel === true ? { importSentinelPath } : {}),
  };
}

/**
 * The env var name the test sets so the forked worker TRUSTS the installed
 * fixture (installed tools are deny-by-default; the supervisor forks with the
 * parent env, so the value is inherited).
 */
export const FIXTURE_TRUST_ENV = 'OPENSIP_CLI_ALLOW_INSTALLED_TOOLS';
