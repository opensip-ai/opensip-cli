import {
  PLUGIN_API_VERSION,
  PROJECT_LOCAL_MANIFEST_FILE,
  readPackageVersion,
} from '@opensip-cli/core';

export type ToolsCreateTemplate = 'minimal-js' | 'ts-local';

export interface TemplateRenderedFile {
  readonly relativePath: string;
  readonly content: string;
}

export interface TemplateRenderContext {
  readonly toolId: string;
  readonly stableId: string;
  readonly commandName: string;
}

export interface TemplateRenderResult {
  readonly files: readonly TemplateRenderedFile[];
  readonly nextSteps: readonly string[];
}

export type TemplateRenderer = (ctx: TemplateRenderContext) => TemplateRenderResult;

const CORE_PACKAGE_VERSION = readPackageVersion(
  new URL('../../../../core/package.json', import.meta.url).href,
);

function manifestBlock(ctx: TemplateRenderContext, main: string): Record<string, unknown> {
  return {
    kind: 'tool',
    id: ctx.toolId,
    identity: { name: ctx.toolId },
    stableId: ctx.stableId,
    name: ctx.toolId,
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    main,
    commands: [{ name: ctx.commandName, description: `Run ${ctx.toolId}` }],
  };
}

function manifestJson(ctx: TemplateRenderContext, main: string): string {
  return `${JSON.stringify(manifestBlock(ctx, main), null, 2)}\n`;
}

function minimalJsRuntime(ctx: TemplateRenderContext): string {
  return `export const tool = {
  identity: { name: '${ctx.toolId}' },
  metadata: {
    id: '${ctx.stableId}',
    name: '${ctx.toolId}',
    version: '0.1.0',
    description: 'Project-local tool scaffolded by opensip tools create',
  },
  commandSpecs: [
    {
      name: '${ctx.commandName}',
      description: 'Run ${ctx.toolId}',
      commonFlags: ['json'],
      scope: 'none',
      output: 'command-result',
      handler: async () => ({
        type: 'text-lines',
        title: '${ctx.toolId}',
        lines: ['Your project-local tool is ready — allowlist it, then run opensip ${ctx.commandName}.'],
      }),
    },
  ],
};
`;
}

function minimalJsNextSteps(ctx: TemplateRenderContext): readonly string[] {
  const toolDir = `opensip-cli/tools/${ctx.toolId}`;
  return [
    `export OPENSIP_CLI_ALLOW_PROJECT_TOOLS='${ctx.toolId}'`,
    `opensip tools validate ${toolDir}`,
    `opensip ${ctx.commandName}`,
    'Validation executes candidate code in a child process; it is not a security sandbox.',
  ];
}

function tsLocalIndexTs(ctx: TemplateRenderContext): string {
  return `import { createTool } from '@opensip-cli/core';

export const tool = createTool({
  identity: { name: '${ctx.toolId}' },
  metadata: {
    id: '${ctx.stableId}',
    version: '0.1.0',
    description: 'Project-local typed tool scaffolded by opensip tools create',
  },
  primaryCommand: {
    description: 'Run ${ctx.toolId}',
    commonFlags: ['json'],
    scope: 'none',
    output: 'command-result',
    handler: async () => ({
      type: 'text-lines',
      title: '${ctx.toolId}',
      lines: ['Your typed project-local tool is ready — build, validate, allowlist, then run.'],
    }),
  },
});
`;
}

function tsLocalIndexTest(ctx: TemplateRenderContext): string {
  return `import { describe, expect, it } from 'vitest';

import { tool } from './index.js';

describe('${ctx.toolId} tool', () => {
  it('exports identity-derived metadata and commands without extension hooks', () => {
    expect(tool.metadata.name).toBe('${ctx.toolId}');
    expect(tool.metadata.id).toBe('${ctx.stableId}');
    expect(tool.commandSpecs?.map((spec) => spec.name)).toEqual(['${ctx.commandName}']);
    expect(tool.extensionPoints).toBeUndefined();
  });
});
`;
}

function tsLocalPackageJson(ctx: TemplateRenderContext): string {
  return `${JSON.stringify(
    {
      name: `@opensip-cli/tool-${ctx.toolId}`,
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: {
        build: 'tsc',
        test: 'vitest run',
        validate: 'opensip tools validate . --install-deps',
      },
      dependencies: {
        '@opensip-cli/core': `^${CORE_PACKAGE_VERSION}`,
      },
      devDependencies: {
        '@types/node': '^24.13.2',
        typescript: '~6.0.3',
        vitest: '^4.1.8',
      },
    },
    null,
    2,
  )}\n`;
}

function tsLocalTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        declaration: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  )}\n`;
}

function tsLocalReadme(ctx: TemplateRenderContext): string {
  const toolDir = `opensip-cli/tools/${ctx.toolId}`;
  return `# ${ctx.toolId}

Typed project-local Tool scaffolded by \`opensip tools create --template ts-local\`.

## Build and validate

\`\`\`bash
cd ${toolDir}
pnpm install   # or npm install
pnpm run build
pnpm test
opensip tools validate ${toolDir} --install-deps
\`\`\`

## Allowlist and run

Project-local tools are executable code and deny-by-default until allowlisted:

\`\`\`bash
export OPENSIP_CLI_ALLOW_PROJECT_TOOLS='${ctx.toolId}'
opensip ${ctx.commandName}
\`\`\`

Do not use wildcard allowlists unless you trust every project-local tool in the repo.
Validation executes candidate code in a child process; it is not a security sandbox.
`;
}

function tsLocalNextSteps(ctx: TemplateRenderContext): readonly string[] {
  const toolDir = `opensip-cli/tools/${ctx.toolId}`;
  return [
    `cd ${toolDir} && pnpm install`,
    'pnpm run build',
    'pnpm test',
    `opensip tools validate ${toolDir} --install-deps`,
    `export OPENSIP_CLI_ALLOW_PROJECT_TOOLS='${ctx.toolId}'`,
    `opensip ${ctx.commandName}`,
    'Validation executes candidate code in a child process; it is not a security sandbox.',
  ];
}

export const TOOLS_CREATE_TEMPLATES: readonly ToolsCreateTemplate[] = ['minimal-js', 'ts-local'];

export function isToolsCreateTemplate(value: string): value is ToolsCreateTemplate {
  return (TOOLS_CREATE_TEMPLATES as readonly string[]).includes(value);
}

export const TOOLS_CREATE_TEMPLATE_RENDERERS: Record<ToolsCreateTemplate, TemplateRenderer> = {
  'minimal-js': (ctx) => ({
    files: [
      { relativePath: PROJECT_LOCAL_MANIFEST_FILE, content: manifestJson(ctx, './index.mjs') },
      { relativePath: 'index.mjs', content: minimalJsRuntime(ctx) },
    ],
    nextSteps: minimalJsNextSteps(ctx),
  }),
  'ts-local': (ctx) => ({
    files: [
      { relativePath: PROJECT_LOCAL_MANIFEST_FILE, content: manifestJson(ctx, './dist/index.js') },
      { relativePath: 'package.json', content: tsLocalPackageJson(ctx) },
      { relativePath: 'tsconfig.json', content: tsLocalTsconfig() },
      { relativePath: 'src/index.ts', content: tsLocalIndexTs(ctx) },
      { relativePath: 'src/index.test.ts', content: tsLocalIndexTest(ctx) },
      { relativePath: 'README.md', content: tsLocalReadme(ctx) },
    ],
    nextSteps: tsLocalNextSteps(ctx),
  }),
};
