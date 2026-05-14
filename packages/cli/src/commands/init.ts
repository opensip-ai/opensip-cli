/**
 * init command — generate opensip-tools.config.yml
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CliArgs , InitResult } from '@opensip-tools/cli-shared';

// ---------------------------------------------------------------------------
// Init config generation
// ---------------------------------------------------------------------------

export const INIT_FILENAME = 'opensip-tools.config.yml';

// eslint-disable-next-line sonarjs/cognitive-complexity -- config generator emits multiple project shapes (packages/src/apps/Next.js); flattening would scatter related output
export function generateInitConfig(cwd: string): string {
  // Detect project shape by looking for common patterns
  const hasPackagesDir = existsSync(join(cwd, 'packages'));
  const hasSrcDir = existsSync(join(cwd, 'src'));
  const hasAppDir = existsSync(join(cwd, 'app'));
  const hasAppsDir = existsSync(join(cwd, 'apps'));

  // Detect frontend
  const pkgJsonPath = join(cwd, 'package.json');
  let hasReact = false;
  let hasNext = false;
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      hasReact = 'react' in allDeps;
      hasNext = 'next' in allDeps;
    } catch { /* ignore */ }
  }

  const lines: string[] = [
    '# OpenSIP Tools \u2014 Signalers Configuration',
    '#',
    '# Defines named file sets (targets) for fitness checks and configures',
    '# how each signal producer analyzes the codebase.',
    '#',
    '# Docs: https://github.com/opensip-ai/opensip-tools#configuration',
    '',
    '# =============================================================================',
    '# Targets',
    '# =============================================================================',
    '',
    'globalExcludes: []',
    '',
    'targets:',
  ];

  // Determine source pattern
  let srcPattern: string;
  if (hasPackagesDir) srcPattern = 'packages/*/src/**/*.ts';
  else if (hasSrcDir) srcPattern = 'src/**/*.ts';
  else srcPattern = '**/*.ts';

  const srcInclude: string[] = [srcPattern];

  if (hasAppsDir) {
    srcInclude.push('apps/*/src/**/*.ts');
  }

  // Backend target
  lines.push(
    '  backend:',
    '    description: Backend source code',
    '    languages: [typescript]',
    '    concerns: [backend, server, api]',
    '    include:',
    ...srcInclude.map(p => `      - "${p}"`),
    '    exclude:',
    '      - "**/*.test.ts"',
    '      - "**/__tests__/**"',
    '      - "**/node_modules/**"',
    '      - "**/dist/**"',
    '    tags:',
    '      - production',
    '      - typescript',
    '',
  );

  // Frontend target (only if React detected)
  if (hasReact) {
    let frontendInclude: string[];
    if (hasNext) {
      frontendInclude = hasAppDir
        ? ['app/**/*.tsx', 'app/**/*.ts']
        : ['pages/**/*.tsx', 'src/**/*.tsx'];
    } else if (hasAppsDir) {
      frontendInclude = ['apps/*/src/**/*.tsx', 'apps/*/src/**/*.ts'];
    } else if (hasSrcDir) {
      frontendInclude = ['src/**/*.tsx', 'src/**/*.ts'];
    } else {
      frontendInclude = ['**/*.tsx'];
    }

    lines.push(
      '  frontend:',
      '    description: Frontend React code',
      '    languages: [typescript, tsx]',
      '    concerns: [frontend, ui, browser, react]',
      '    include:',
      ...frontendInclude.map(p => `      - "${p}"`),
      '    exclude:',
      '      - "**/*.test.ts"',
      '      - "**/*.test.tsx"',
      '      - "**/node_modules/**"',
      '      - "**/dist/**"',
      '    tags:',
      '      - production',
      '      - react',
      '      - typescript',
      '',
    );
  }

  // Tests target
  lines.push(
    '  tests:',
    '    description: All test files',
    '    languages: [typescript]',
    '    concerns: [testing]',
    '    include:',
    '      - "**/*.test.ts"',
    '      - "**/__tests__/**/*.ts"',
    '    exclude:',
    '      - "**/node_modules/**"',
    '      - "**/dist/**"',
    '    tags:',
    '      - testing',
    '      - typescript',
    '', 
    '  all-ts:',
    '    description: All TypeScript files',
    '    languages: [typescript]',
    '    include:',
    `      - "${srcPattern}"`,
    '    exclude:',
    '      - "**/node_modules/**"',
    '      - "**/dist/**"',
    '    tags:',
    '      - typescript',
    '', 
    '  configs:',
    '    description: Configuration files',
    '    languages: [json, typescript, yaml]',
    '    concerns: [config]',
    '    include:',
    '      - "**/tsconfig.json"',
    '      - "**/package.json"',
    '    exclude:',
    '      - "**/node_modules/**"',
    '    tags:',
    '      - config',
    '', 
    '# =============================================================================',
    '# Fitness Configuration',
    '# =============================================================================',
    '',
    'fitness:',
    '  failOnErrors: 1     # fail if total errors >= this (0 = never fail on errors)',
    '  failOnWarnings: 0   # fail if total warnings >= this (0 = warnings are informational)',
    '  disabledChecks: []',
    '',
  
  
  
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// executeInit
// ---------------------------------------------------------------------------

export function executeInit(args: CliArgs): InitResult {
  const targetPath = join(args.cwd, INIT_FILENAME);

  if (!existsSync(args.cwd)) {
    return {
      type: 'init',
      created: false,
      path: targetPath,
      alreadyExists: false,
      cwd: args.cwd,
      configFilename: INIT_FILENAME,
    };
  }

  if (existsSync(targetPath)) {
    return {
      type: 'init',
      created: false,
      path: targetPath,
      alreadyExists: true,
      cwd: args.cwd,
      configFilename: INIT_FILENAME,
    };
  }

  const content = generateInitConfig(args.cwd);
  writeFileSync(targetPath, content, 'utf8');

  return {
    type: 'init',
    created: true,
    path: targetPath,
    alreadyExists: false,
    cwd: args.cwd,
    configFilename: INIT_FILENAME,
  };
}
