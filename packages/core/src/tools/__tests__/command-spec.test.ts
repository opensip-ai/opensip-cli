import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  COMMON_FLAG_KEYS,
  defineCommand,
  type ArgSpec,
  type CommandSpec,
  type CommonFlagKey,
  type OptionSpec,
} from '../command-spec.js';

const noopHandler = (): undefined => undefined;

function baseSpec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    name: 'graph',
    description: 'Build the static call graph',
    commonFlags: ['cwd', 'json'],
    scope: 'project',
    output: 'signal-envelope',
    handler: noopHandler,
    ...overrides,
  };
}

describe('defineCommand', () => {
  it('returns the spec unchanged (identity) for a valid spec', () => {
    const spec = baseSpec();
    expect(defineCommand(spec)).toBe(spec);
  });

  it('accepts every CommonFlagKey', () => {
    const spec = defineCommand(baseSpec({ commonFlags: [...COMMON_FLAG_KEYS] }));
    expect(spec.commonFlags).toEqual(COMMON_FLAG_KEYS);
  });

  it('rejects an empty name', () => {
    expect(() => defineCommand(baseSpec({ name: '   ' }))).toThrow(/non-empty string/);
  });

  it('rejects an empty description', () => {
    expect(() => defineCommand(baseSpec({ description: '' }))).toThrow(/non-empty description/);
  });

  it('rejects a non-function handler', () => {
    expect(() =>
      // @ts-expect-error — deliberately wrong handler type for the runtime guard
      defineCommand(baseSpec({ handler: 'nope' })),
    ).toThrow(/function handler/);
  });

  it('rejects an unknown common-flag key', () => {
    expect(() =>
      defineCommand(baseSpec({ commonFlags: ['cwd', 'bogus' as CommonFlagKey] })),
    ).toThrow(/unknown common flag 'bogus'/);
  });

  it('rejects duplicate common-flag keys', () => {
    expect(() =>
      defineCommand(baseSpec({ commonFlags: ['cwd', 'cwd'] })),
    ).toThrow(/duplicate common flag 'cwd'/);
  });

  it('does not invoke the handler at definition time', () => {
    const handler = vi.fn();
    defineCommand(baseSpec({ handler }));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('OptionSpec corpus coverage', () => {
  // Each case below is a real first-party flag shape from the Phase 0 corpus,
  // asserting the type expresses it with zero raw-Commander escape.
  it('expresses a boolean flag with default (--gate-save)', () => {
    const opt: OptionSpec = { flag: '--gate-save', description: 'Save baseline', default: false };
    expect(opt.value).toBeUndefined();
    expect(opt.default).toBe(false);
  });

  it('expresses a negatable flag (--no-cache)', () => {
    const opt: OptionSpec = { flag: '--no-cache', description: 'Skip cache', negatable: true };
    expect(opt.negatable).toBe(true);
  });

  it('expresses a value flag (--recipe <name>)', () => {
    const opt: OptionSpec = { flag: '--recipe', value: '<name>', description: 'Run a recipe' };
    expect(opt.value).toBe('<name>');
  });

  it('expresses value + default + choices (--resolution <mode>)', () => {
    const opt: OptionSpec = {
      flag: '--resolution',
      value: '<mode>',
      description: 'Edge resolution tier',
      default: 'exact',
      choices: ['exact', 'fast'],
    };
    expect(opt.choices).toEqual(['exact', 'fast']);
    expect(opt.default).toBe('exact');
  });

  it('expresses a custom scalar parser (--concurrency <n>)', () => {
    const opt: OptionSpec = {
      flag: '--concurrency',
      value: '<n>',
      description: 'Concurrency cap',
      parse: (raw) => Number.parseInt(raw, 10),
    };
    expect(opt.parse?.('4', undefined)).toBe(4);
  });

  it('expresses a repeatable reducer flag (--exclude <slug>)', () => {
    const opt: OptionSpec = {
      flag: '--exclude',
      value: '<slug>',
      description: 'Exclude check (repeatable)',
      arrayDefault: [],
      parse: (raw, prev) => [...(prev as string[]), raw],
    };
    expect(opt.parse?.('b', ['a'])).toEqual(['a', 'b']);
    expect(opt.arrayDefault).toEqual([]);
  });

  it('expresses a required value flag (--out <path>)', () => {
    const opt: OptionSpec = {
      flag: '--out',
      value: '<path>',
      description: 'Output file path',
      required: true,
    };
    expect(opt.required).toBe(true);
  });

  it('expresses a short-aliased boolean (-y, --yes)', () => {
    const opt: OptionSpec = { flag: '-y, --yes', description: 'Skip confirmation', default: false };
    expect(opt.flag).toContain('-y');
  });

  it('expresses an optional-value flag (--project [path])', () => {
    const opt: OptionSpec = {
      flag: '--project',
      value: '[path]',
      description: 'Remove project-local runtime state',
    };
    expect(opt.value).toBe('[path]');
  });
});

describe('ArgSpec corpus coverage', () => {
  it('expresses a variadic optional positional ([paths...])', () => {
    const arg: ArgSpec = { name: 'paths', description: 'Subtrees', variadic: true, optional: true };
    expect(arg.variadic).toBe(true);
    expect(arg.optional).toBe(true);
  });

  it('expresses a required positional (<name>)', () => {
    const arg: ArgSpec = { name: 'name', description: 'Function name to look up' };
    expect(arg.variadic).toBeUndefined();
    expect(arg.optional).toBeUndefined();
  });
});

describe('core stays Commander-free (Phase 0 layering invariant)', () => {
  // The command-plane TYPES live in core, but the Commander-touching mounting
  // runtime lives in cli and the `applyCommonFlags` runtime in contracts. core
  // must NOT depend on or import `commander` — the kernel is a pure data layer.
  // This asserts the invariant directly (the dependency-cruiser layer gate
  // forbids the cross-package edge; this complements it at the kernel root).
  const HERE = dirname(fileURLToPath(import.meta.url));
  // __tests__ → tools → src → core
  const CORE_ROOT = resolve(HERE, '../../..');

  it('declares no `commander` dependency in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).not.toHaveProperty('commander');
    expect(pkg.peerDependencies ?? {}).not.toHaveProperty('commander');
    expect(pkg.devDependencies ?? {}).not.toHaveProperty('commander');
  });

  it('no source file under packages/core/src imports commander', () => {
    const offenders: string[] = [];
    const COMMANDER_IMPORT = /from\s+['"]commander['"]|require\(\s*['"]commander['"]/;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && COMMANDER_IMPORT.test(readFileSync(full, 'utf8'))) {
          offenders.push(full);
        }
      }
    };
    walk(join(CORE_ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('CommandSpec shape', () => {
  it('carries options, args, scope and output', () => {
    const spec = defineCommand(
      baseSpec({
        aliases: ['list-checks'],
        options: [{ flag: '--no-cache', description: 'Skip cache', negatable: true }],
        args: [{ name: 'paths', description: 'Subtrees', variadic: true, optional: true }],
        output: 'live-view',
        scope: 'none',
      }),
    );
    expect(spec.aliases).toEqual(['list-checks']);
    expect(spec.options).toHaveLength(1);
    expect(spec.args).toHaveLength(1);
    expect(spec.output).toBe('live-view');
    expect(spec.scope).toBe('none');
  });
});
