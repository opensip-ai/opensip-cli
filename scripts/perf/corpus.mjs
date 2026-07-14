import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const MARKER_FILE = '.opensip-slo-corpus.json';
const GIT_COMMAND_TIMEOUT_MS = 10_000;
const GIT_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;
const GIT_ENV_PASSTHROUGH_KEYS = [
  'COMSPEC',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WINDIR',
];
const CORPUS_ROOT_FILES = [
  'opensip-cli.config.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
];

export function corpusMarkerPath(root) {
  return join(root, MARKER_FILE);
}

export async function cleanupOwnedCorpus(root) {
  const marker = corpusMarkerPath(root);
  if (!existsSync(marker)) {
    throw new Error(`Refusing to delete ${root}: missing ${MARKER_FILE}.`);
  }
  await rm(root, { recursive: true, force: true });
}

export async function materializeCorpus(input) {
  const root = resolve(input.root);
  if (existsSync(root)) await cleanupOwnedCorpus(root);
  await mkdir(join(root, 'src'), { recursive: true });

  const fileCount = input.quick ? input.tier.quickFileCount : input.tier.fileCount;
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(
      join(root, 'src', `module-${index}.ts`),
      renderTypeScriptModule(index, fileCount),
    );
  }

  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        type: 'module',
        private: true,
        packageManager:
          'pnpm@11.5.1+sha512.93f7b57422ea7068257235b4c16eb60762eb68e1dc23723199cc739043ea9be2c4143274a399d8c6defa2b1176226d9ca1c4b63482d6200c1a8fbaa78c1d1485',
        scripts: { build: 'tsc -p tsconfig.json' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n\nsettings: {}\n');
  await writeFile(
    join(root, 'pnpm-workspace.yaml'),
    [
      'packages: []',
      'allowBuilds: {}',
      'minimumReleaseAge: 1440',
      'minimumReleaseAgeStrict: true',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'opensip-cli.config.yml'), renderOpenSipConfig());
  await writeFile(
    corpusMarkerPath(root),
    `${JSON.stringify(
      {
        version: 1,
        tier: input.tierId,
        quick: input.quick,
        fileCount,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  const gitReady = initializeGitCorpus(root);
  const changedFile = join(root, 'src', 'module-0.ts');
  await appendChangedProbe(changedFile);
  const contentSha256 = await fingerprintCorpusContents(root, fileCount);

  return {
    root,
    tier: input.tierId,
    fileCount,
    changedFiles: ['src/module-0.ts'],
    gitReady,
    contentSha256,
  };
}

async function fingerprintCorpusContents(root, fileCount) {
  const relativePaths = [
    ...CORPUS_ROOT_FILES,
    ...Array.from({ length: fileCount }, (_, index) => `src/module-${String(index)}.ts`),
  ].sort((left, right) => left.localeCompare(right));
  const hash = createHash('sha256');
  for (const relativePath of relativePaths) {
    const content = await readFile(join(root, relativePath));
    const pathBytes = Buffer.byteLength(relativePath, 'utf8');
    hash.update(`${String(pathBytes)}:`);
    hash.update(relativePath, 'utf8');
    hash.update(`${String(content.byteLength)}:`);
    hash.update(content);
  }
  return hash.digest('hex');
}

function renderTypeScriptModule(index, fileCount) {
  const imports = [];
  const calls = [];
  for (const target of [index + 1, index + 2].filter((value) => value < fileCount)) {
    imports.push(`import { value${target}, compute${target} } from './module-${target}.js';`);
    calls.push(`  total += compute${target}(input + value${target});`);
  }
  const branch = index % 4;
  const extraLines = Array.from({ length: 6 }, (_, line) => {
    const offset = index + line + 1;
    return `  total += (input + ${offset}) % ${branch + 2};`;
  });
  return `${imports.join('\n')}${imports.length === 0 ? '' : '\n\n'}export const value${index} = ${index};

export interface Shape${index} {
  readonly id: string;
  readonly value: number;
}

export function compute${index}(input: number): number {
  let total = input + value${index};
${extraLines.join('\n')}
${calls.join('\n')}
  return total;
}

export function describe${index}(shape: Shape${index}): string {
  const computed = compute${index}(shape.value);
  return \`\${shape.id}:\${computed}\`;
}
`;
}

function renderOpenSipConfig() {
  return `targets:
  app:
    description: Synthetic TypeScript source generated for the performance SLO lane
    languages: [typescript]
    concerns: [backend, server]
    include:
      - "src/**/*.ts"
fitness:
  recipe: agent-fast
  failOnErrors: 1
  failOnWarnings: 0
graph:
  failOnErrors: 1
  failOnWarnings: 0
  highBlastWarnThreshold: 999999
  highBlastErrorThreshold: 999999
`;
}

export function initializeGitCorpus(root, dependencies = {}) {
  const spawnGit = dependencies.spawnSync ?? spawnSync;
  const hooksPath = join(root, '.git', 'opensip-disabled-hooks');
  const repositoryOptions = [
    '-c',
    `core.hooksPath=${hooksPath}`,
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.eol=lf',
  ];
  const commands = [
    ['--version'],
    ['init', '--quiet', '--initial-branch=main', '--template='],
    [...repositoryOptions, 'add', '--all', '--', '.'],
    [
      ...repositoryOptions,
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '--no-verify',
      '-m',
      'baseline',
    ],
  ];
  const options = {
    cwd: root,
    env: createGitCorpusEnv(root, dependencies.env ?? process.env),
    stdio: 'ignore',
    timeout: GIT_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: GIT_COMMAND_MAX_OUTPUT_BYTES,
    windowsHide: true,
  };

  try {
    for (const args of commands) {
      if (spawnGit('git', args, options).status !== 0) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function createGitCorpusEnv(root, source) {
  const env = {};
  const sourceKeys = Object.keys(source);
  for (const expectedKey of GIT_ENV_PASSTHROUGH_KEYS) {
    const sourceKey = sourceKeys.find((key) => key.toUpperCase() === expectedKey);
    const value = sourceKey === undefined ? undefined : source[sourceKey];
    if (sourceKey !== undefined && typeof value === 'string' && value.length > 0) {
      env[sourceKey] = value;
    }
  }

  return {
    ...env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, '.git', 'opensip-disabled-xdg-config'),
    GIT_CONFIG_GLOBAL: join(root, '.git', 'opensip-disabled-global-config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_AUTHOR_NAME: 'OpenSIP SLO',
    GIT_AUTHOR_EMAIL: 'opensip-slo@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'OpenSIP SLO',
    GIT_COMMITTER_EMAIL: 'opensip-slo@example.invalid',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  };
}

async function appendChangedProbe(filePath) {
  const content = await readFile(filePath, 'utf8');
  await writeFile(filePath, `${content}\nexport const changedProbe = compute0(1);\n`);
}
