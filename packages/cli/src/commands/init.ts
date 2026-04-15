/**
 * init command — generate opensip-tools.config.yml
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CliArgs } from '../types.js';
import type { InitResult } from '../types.js';

// ---------------------------------------------------------------------------
// Init config generation
// ---------------------------------------------------------------------------

export const INIT_FILENAME = 'opensip-tools.config.yml';

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
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
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
  const srcPattern = hasPackagesDir
    ? 'packages/*/src/**/*.ts'
    : hasSrcDir
      ? 'src/**/*.ts'
      : '**/*.ts';

  const srcInclude = hasPackagesDir
    ? ['packages/*/src/**/*.ts']
    : hasSrcDir
      ? ['src/**/*.ts']
      : ['**/*.ts'];

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
    const frontendInclude = hasNext
      ? hasAppDir ? ['app/**/*.tsx', 'app/**/*.ts'] : ['pages/**/*.tsx', 'src/**/*.tsx']
      : hasAppsDir
        ? ['apps/*/src/**/*.tsx', 'apps/*/src/**/*.ts']
        : hasSrcDir
          ? ['src/**/*.tsx', 'src/**/*.ts']
          : ['**/*.tsx'];

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
  );

  // All-ts catch-all
  lines.push(
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
  );

  // Configs target
  lines.push(
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
  );

  // Fitness config
  lines.push(
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
  writeFileSync(targetPath, content, 'utf-8');

  return {
    type: 'init',
    created: true,
    path: targetPath,
    alreadyExists: false,
    cwd: args.cwd,
    configFilename: INIT_FILENAME,
  };
}
