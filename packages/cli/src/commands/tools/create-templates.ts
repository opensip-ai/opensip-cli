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
      handler: async (opts, cli) => {
        cli.logger.info({ evt: '${ctx.toolId}.run.start', module: '${ctx.toolId}:cli' });
        try {
          return {
            type: 'text-lines',
            title: '${ctx.toolId}',
            lines: ['Your project-local tool is ready — validate it, then run opensip ${ctx.commandName}.'],
          };
        } catch (error) {
          // The host normalizes any caught value; return after reporting so this
          // command-result handler does not fall through to an undefined result.
          await cli.reportFailure({ error, jsonRequested: opts.json === true });
          return;
        }
      },
    },
  ],
};
`;
}

function minimalJsNextSteps(ctx: TemplateRenderContext): readonly string[] {
  const toolDir = `opensip-cli/tools/${ctx.toolId}`;
  return [
    `opensip tools validate ${toolDir}`,
    `opensip ${ctx.commandName}`,
    'Run logs land under opensip-cli/.runtime/logs/ when the host configures logging.',
    'Validation executes candidate code in a child process; it is not a security sandbox.',
  ];
}

function tsLocalIndexTs(ctx: TemplateRenderContext): string {
  return `import { createTool, createToolLogger } from '@opensip-cli/core';

const log = createToolLogger('${ctx.toolId}:cli');

function isJsonRequested(opts: unknown): boolean {
  return typeof opts === 'object' && opts !== null && 'json' in opts && opts.json === true;
}

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
    handler: async (opts, cli) => {
      log.info({ evt: '${ctx.toolId}.run.start' });
      try {
        return {
          type: 'text-lines',
          title: '${ctx.toolId}',
          lines: ['Your typed project-local tool is ready — build, validate, then run.'],
        };
      } catch (error) {
        // The host normalizes any caught value; return after reporting so this
        // command-result handler does not fall through to an undefined result.
        await cli.reportFailure({ error, jsonRequested: isJsonRequested(opts) });
        return;
      }
    },
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

## Trust and run

Project-local tools are executable code and deny-by-default until trusted. The
scaffold command adds this tool id to \`tools.trusted\` in
\`opensip-cli.config.yml\`.

\`\`\`bash
opensip ${ctx.commandName}
\`\`\`

Use \`OPENSIP_CLI_ALLOW_PROJECT_TOOLS\` only as an incident-response override.
Run logs land under \`opensip-cli/.runtime/logs/\` when the host configures logging.
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
      {
        relativePath: PROJECT_LOCAL_MANIFEST_FILE,
        content: manifestJson(ctx, './index.mjs'),
      },
      { relativePath: 'index.mjs', content: minimalJsRuntime(ctx) },
    ],
    nextSteps: minimalJsNextSteps(ctx),
  }),
  'ts-local': (ctx) => ({
    files: [
      {
        relativePath: PROJECT_LOCAL_MANIFEST_FILE,
        content: manifestJson(ctx, './dist/index.js'),
      },
      { relativePath: 'package.json', content: tsLocalPackageJson(ctx) },
      { relativePath: 'tsconfig.json', content: tsLocalTsconfig() },
      { relativePath: 'src/index.ts', content: tsLocalIndexTs(ctx) },
      { relativePath: 'src/index.test.ts', content: tsLocalIndexTest(ctx) },
      { relativePath: 'README.md', content: tsLocalReadme(ctx) },
    ],
    nextSteps: tsLocalNextSteps(ctx),
  }),
};
