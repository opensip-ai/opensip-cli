import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const MARKER_FILE = '.opensip-slo-corpus.json';

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

  return {
    root,
    tier: input.tierId,
    fileCount,
    changedFiles: ['src/module-0.ts'],
    gitReady,
  };
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

function initializeGitCorpus(root) {
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) return false;
  for (const args of [
    ['init'],
    ['config', 'user.email', 'opensip-slo@example.invalid'],
    ['config', 'user.name', 'OpenSIP SLO'],
    ['add', '.'],
    ['commit', '-m', 'baseline'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, stdio: 'ignore' });
    if (result.status !== 0) return false;
  }
  return true;
}

async function appendChangedProbe(filePath) {
  const content = await readFile(filePath, 'utf8');
  await writeFile(filePath, `${content}\nexport const changedProbe = compute0(1);\n`);
}
