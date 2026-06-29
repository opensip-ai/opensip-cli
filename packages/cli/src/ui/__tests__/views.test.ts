import { renderToText } from '@opensip-cli/cli-ui';
import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { HOST_VERDICT_POLICY_FALLBACK } from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';

import { resultToView } from '../result-to-view.js';

import type { CommandResult } from '@opensip-cli/contracts';

const text = (r: CommandResult): string => renderToText(resultToView(r));

describe('list-checks view', () => {
  it('groups by tag (sorted), falls back to untagged, lists slugs + descriptions', () => {
    const out = text({
      type: 'list-checks',
      totalCount: 2,
      checks: [
        { slug: 'no-console', description: 'no console', tags: ['quality'] },
        { slug: 'loose', description: 'untagged check', tags: [] },
      ],
    });
    expect(out).toContain('Available Fitness Checks (2 total)');
    expect(out).toContain('quality (1)');
    expect(out).toContain('untagged (1)');
    expect(out).toContain('no-console — no console');
  });
});

describe('list-recipes view', () => {
  it('lists recipe name, description, and check count', () => {
    const out = text({
      type: 'list-recipes',
      recipes: [{ name: 'example', description: 'demo recipe', checkCount: '5 checks' }],
    });
    expect(out).toContain('Available Recipes');
    expect(out).toContain('example — demo recipe (5 checks)');
  });
});

describe('history view', () => {
  it('renders the empty state', () => {
    expect(text({ type: 'history', sessions: [] })).toContain('No sessions recorded yet');
  });

  it('renders rows with score, PASS/FAIL, counts, recipe, duration', () => {
    const out = text({
      type: 'history',
      sessions: [
        {
          id: 'FIT_1',
          tool: 'fit',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.000Z',
          score: 95,
          passed: true,
          durationMs: 1500,
          recipe: 'example',
          payload: { summary: { passed: 9, total: 10 } },
          showCommand: 'opensip sessions show FIT_1 --json',
        } as never,
        {
          id: 'GRAPH_2',
          tool: 'graph',
          startedAt: '2026-01-02T00:00:00.000Z',
          completedAt: '2026-01-02T00:00:00.000Z',
          score: 40,
          passed: false,
          durationMs: 500,
          payload: {},
          showCommand: 'opensip sessions show GRAPH_2 --json',
        } as never,
      ],
    });
    expect(out).toContain('Run History (2 sessions)');
    // Aligned table with a header row (the columns line up by construction now).
    expect(out).toContain('Session');
    expect(out).toContain('Tool');
    expect(out).toContain('Status');
    expect(out).toContain('Recipe');
    expect(out).toContain('Duration');
    expect(out).toContain('FIT_1');
    expect(out).toContain('fit');
    expect(out).toContain('GRAPH_2');
    expect(out).toContain('graph');
    expect(out).toContain('95%');
    expect(out).toContain('PASS');
    expect(out).toContain('9/10'); // counts column (header carries the word "Checks")
    expect(out).toContain('example'); // recipe column (no parens)
    expect(out).toContain('40%');
    expect(out).toContain('FAIL');
    // The Session column header aligns with the id cells beneath it.
    const lines = out.split('\n');
    const header = lines.find((l) => l.includes('Session') && l.includes('Tool'))!;
    const fitRow = lines.find((l) => l.includes('FIT_1'))!;
    expect(fitRow.indexOf('FIT_1')).toBe(header.indexOf('Session'));
  });
});

describe('session-replay view', () => {
  it('renders a header, recipe, FAIL verdict, and the shared envelope table (no live footer)', () => {
    const envelope = buildSignalEnvelope({
      tool: 'graph',
      runId: 'GRAPH_X',
      createdAt: '2026-01-01T00:00:00.000Z',
      units: [
        {
          slug: 'graph:cycle',
          passed: false,
          violationCount: 2,
          durationMs: 0,
        },
      ],
      signals: [],
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
    });
    const out = text({
      type: 'session-replay',
      session: {
        id: 'GRAPH_X',
        tool: 'graph',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:00.000Z',
        recipe: 'strict',
        score: 60,
        passed: false,
        durationMs: 1200,
      },
      envelope,
      fidelity: 'projection',
    });
    expect(out).toContain('Session GRAPH_X');
    expect(out).toContain('graph');
    expect(out).toContain('recipe strict'); // recipe-present branch
    expect(out).toContain('FAIL'); // passed:false verdict branch
    expect(out).toContain('replayed (projection)');
    expect(out).toContain('graph:cycle'); // the shared envelope table body
    // The live-run footer must NOT appear on a replay.
    expect(out).not.toContain('Use --verbose');
    expect(out).not.toContain('report for HTML report');
  });
});

describe('sim notice + help + report views', () => {
  it('renders the sim notice', () => {
    const out = text({ type: 'sim-notice', tool: 'sim', cwd: '/x' });
    expect(out).toContain('Simulation');
    expect(out).toContain('Available in OpenSIP CLI 1.0.0');
  });

  it('renders help commands', () => {
    expect(text({ type: 'help' })).toContain('Run fitness checks');
  });

  it('renders report opened / not-opened', () => {
    expect(text({ type: 'report', path: '/r.html', opened: true })).toContain('Opened in browser.');
    expect(text({ type: 'report', path: '/r.html', opened: false })).toContain(
      'Open the file in your browser',
    );
  });
});

describe('clear/configure/uninstall done views', () => {
  it('clear-done: empty / cancelled / done', () => {
    expect(
      text({
        type: 'clear-done',
        action: 'empty',
        deletedCount: 0,
        sessionCount: 0,
      }),
    ).toContain('No session data');
    expect(
      text({
        type: 'clear-done',
        action: 'cancelled',
        deletedCount: 0,
        sessionCount: 3,
      }),
    ).toContain('Cancelled');
    expect(
      text({
        type: 'clear-done',
        action: 'done',
        deletedCount: 1,
        sessionCount: 1,
      }),
    ).toContain('1 session deleted.');
  });

  it('configure-done: saved / cancelled', () => {
    expect(text({ type: 'configure-done', action: 'saved', configPath: '/c.yml' })).toContain(
      'API key saved to /c.yml',
    );
    expect(
      text({
        type: 'configure-done',
        action: 'cancelled',
        configPath: '/c.yml',
      }),
    ).toContain('No key provided');
  });

  it('uninstall-done: removed / dry-run / empty / cancelled', () => {
    const base = {
      type: 'uninstall-done',
      mode: 'user',
      rootPath: '/r',
      sizeBytes: 2048,
    } as const;
    expect(
      text({
        ...base,
        action: 'removed',
        targets: [{ path: '/r/a', kind: 'file' }],
      }),
    ).toContain('Removed 1 target');
    expect(
      text({
        ...base,
        action: 'dry-run',
        targets: [{ path: '/r/a', kind: 'file' }],
      }),
    ).toContain('[dry-run]');
    expect(text({ ...base, action: 'empty', targets: [] })).toContain('Nothing to remove');
    expect(text({ ...base, action: 'cancelled', targets: [] })).toContain('Cancelled');
  });

  it('uninstall-done: formats MB/GB sizes, pluralizes, and shows the project-mode hint', () => {
    const base = {
      type: 'uninstall-done',
      mode: 'project',
      rootPath: '/r',
      action: 'removed',
      targets: [
        { path: '/r/a', kind: 'file' },
        { path: '/r/b', kind: 'dir' },
      ],
    } as const;
    expect(text({ ...base, sizeBytes: 5 * 1024 * 1024 })).toContain('MB');
    const gb = text({ ...base, sizeBytes: 3 * 1024 * 1024 * 1024 });
    expect(gb).toContain('GB');
    expect(gb).toContain('Removed 2 targets'); // count !== 1 → plural
    expect(gb).toContain('opensip uninstall'); // project-mode hint
  });
});

describe('init view', () => {
  const base = {
    type: 'init',
    created: true,
    path: '/p/cfg.yml',
    cwd: '/p',
    configFilename: 'opensip-cli.config.yml',
  } as const;

  it('renders the pristine success scaffold with created files + try-it hints', () => {
    const out = text({
      ...base,
      state: 'pristine',
      languages: ['typescript'],
      createdFiles: ['/p/opensip-cli/x.ts'],
      gitignoreUpdated: true,
    });
    expect(out).toContain('Scaffolded for typescript');
    expect(out).toContain('opensip-cli/x.ts');
    expect(out).toContain('.gitignore');
    expect(out).toContain('opensip fit --recipe example');
  });

  it('renders the inside-existing-project refusal verbatim', () => {
    const out = text({
      ...base,
      created: false,
      insideExistingProject: {
        discoveredRoot: '/p',
        message: 'line one\nline two',
      },
    });
    expect(out).toContain('line one');
    expect(out).toContain('line two');
  });

  it('renders the ambiguous-language refusal', () => {
    const out = text({
      ...base,
      created: false,
      ambiguousLanguageError: {
        detected: ['ts', 'py'],
        message: 'pass --language',
      },
    });
    expect(out).toContain('language ambiguous');
    expect(out).toContain('pass --language');
  });

  it('renders the partial-state refusal with file classifications + flag hints', () => {
    const out = text({
      ...base,
      created: false,
      partialStateError: {
        state: 'partial-dir-only',
        preExistingFiles: [{ path: '/p/opensip-cli/c.ts', classification: 'custom' }],
        message: 'm',
      },
    });
    expect(out).toContain('opensip-cli/ present but');
    expect(out).toContain('(custom)');
    expect(out).toContain('opensip init --keep');
    expect(out).toContain('opensip init --remove');
  });

  it('renders the creation-failure fallback', () => {
    expect(text({ ...base, created: false })).toContain('Failed to scaffold');
  });
});

describe('plugin view', () => {
  it('list: with plugins and the empty domains', () => {
    const out = text({
      type: 'plugin-list',
      domains: ['fit', 'sim'],
      totalCount: 1,
      plugins: [{ domain: 'fit', namespace: 'acme', pluginType: 'package' }],
      toolProvenance: [],
    });
    expect(out).toContain('Installed Plugins');
    expect(out).toContain('fit/');
    expect(out).toContain('acme');
    expect(out).toContain('sim/'); // empty domain line
  });

  it('list: totally empty shows the get-started hint', () => {
    expect(
      text({
        type: 'plugin-list',
        domains: ['fit', 'sim', 'tool'],
        totalCount: 0,
        plugins: [],
        toolProvenance: [],
      }),
    ).toContain('No plugins installed');
  });

  it('list: renders the tool-provenance section (source + short manifestHash)', () => {
    const out = text({
      type: 'plugin-list',
      domains: ['fit', 'sim', 'tool'],
      totalCount: 0,
      plugins: [],
      toolProvenance: [
        {
          source: 'bundled',
          id: 'fit',
          version: '2.8.0',
          packageName: '@opensip-cli/fitness',
          resolvedPath: '/pkgs/fitness',
          manifestHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        },
      ],
    });
    expect(out).toContain('Tools (provenance)');
    expect(out).toContain('fit');
    expect(out).toContain('[bundled]');
    expect(out).toContain('abcdef012345'); // 12-char short hash
    expect(out).toContain('@opensip-cli/fitness');
  });

  it('list: renders dynamically contributed domains and tool plugins', () => {
    const out = text({
      type: 'plugin-list',
      domains: ['graph-adapter', 'tool'],
      totalCount: 2,
      plugins: [
        {
          domain: 'graph-adapter',
          namespace: '@acme/graph-go',
          pluginType: 'package',
        },
        {
          domain: 'tool',
          namespace: '@acme/custom-tool',
          pluginType: 'package',
        },
      ],
      toolProvenance: [],
    });

    expect(out).toContain('graph-adapter/');
    expect(out).toContain('@acme/graph-go');
    expect(out).toContain('tool/');
    expect(out).toContain('@acme/custom-tool');
  });

  it('add / remove success and failure', () => {
    expect(text({ type: 'plugin-add', packageName: 'p', success: true })).toContain('Installed p');
    expect(
      text({
        type: 'plugin-add',
        packageName: 'p',
        success: false,
        error: 'eperm',
      }),
    ).toContain('Failed to install p (eperm)');
    expect(text({ type: 'plugin-remove', packageName: 'p', success: true })).toContain('Removed p');
    // remove failure exercises addRemoveView's failure arm for the remove verb.
    expect(
      text({
        type: 'plugin-remove',
        packageName: 'p',
        success: false,
        error: 'busy',
      }),
    ).toContain('Failed to remove p (busy)');
  });

  it('list: a provenance entry without a package name omits the package span', () => {
    const out = text({
      type: 'plugin-list',
      domains: ['tool'],
      totalCount: 0,
      plugins: [],
      toolProvenance: [
        {
          source: 'project-local',
          id: 'localtool',
          version: '1.0.0',
          resolvedPath: '/p',
          manifestHash: '0'.repeat(64),
          // no packageName → the optional package span is skipped
        },
      ],
    });
    expect(out).toContain('Tools (provenance)');
    expect(out).toContain('localtool');
    expect(out).toContain('[project-local]');
  });

  it('sync: a fully-successful populated sync shows the success footer', () => {
    const out = text({
      type: 'plugin-sync',
      synced: [{ domain: 'fit', package: 'a', installed: true }],
      success: true,
    });
    expect(out).toContain('Plugin sync');
    expect(out).toContain('All plugins synced successfully');
  });

  it('sync: empty / populated with errors', () => {
    expect(text({ type: 'plugin-sync', synced: [], success: true })).toContain(
      'No plugins declared',
    );
    const out = text({
      type: 'plugin-sync',
      synced: [
        { domain: 'fit', package: 'a', installed: true },
        { domain: 'sim', package: 'b', installed: false },
      ],
      success: false,
      errors: ['b failed'],
    });
    expect(out).toContain('Plugin sync');
    expect(out).toContain('fit/a');
    expect(out).toContain('b failed');
    expect(out).toContain('One or more plugins failed');
  });
});

describe('suite views', () => {
  it('renders suite run, list, and add results', () => {
    const run = text({
      type: 'suite-run',
      suite: 'security',
      suiteRunId: 'run-1',
      exitCode: 1,
      durationMs: 1200,
      steps: [
        {
          tool: 'fitness',
          command: 'fit',
          exitCode: 0,
          durationMs: 400,
        },
        {
          tool: 'graph',
          command: 'graph',
          exitCode: 1,
          durationMs: 500,
          error: 'gate failed',
        },
      ],
    });
    expect(run).toContain('Suite security');
    expect(run).toContain('gate failed');
    expect(run).toContain('-');

    const list = text({
      type: 'suite-list',
      totalCount: 1,
      suites: [
        {
          name: 'security',
          description: 'security suite',
          steps: [
            {
              tool: 'fitness',
              stableId: 'uuid-1',
              command: 'fit',
              args: { recipe: 'security' },
            },
          ],
        },
      ],
    });
    expect(list).toContain('Suites (1)');
    expect(list).toContain('security');
    expect(list).toContain('uuid-1');

    expect(
      text({
        type: 'suite-add',
        suite: 'security',
        tool: 'fitness',
        stableId: 'uuid-1',
        command: 'fit',
        configPath: '/workspace/opensip-cli.config.yml',
        changed: true,
      }),
    ).toContain('Added fitness fit to security');

    expect(
      text({
        type: 'suite-add',
        suite: 'security',
        tool: 'fitness',
        stableId: 'uuid-1',
        command: 'fit',
        configPath: '/workspace/opensip-cli.config.yml',
        changed: false,
      }),
    ).toContain('Suite already contained');

    expect(
      text({
        type: 'suite-list',
        totalCount: 0,
        suites: [],
      }),
    ).toContain('No suites configured');
  });
});

describe('tools command views via resultToView', () => {
  it('routes tools create and doctor results through the shared mapper', () => {
    expect(
      text({
        type: 'tools-create',
        toolId: 'demo-tool',
        dir: '/workspace/demo-tool',
        files: [],
        success: false,
        error: 'exists',
      }),
    ).toContain('Tool scaffold failed');

    expect(
      text({
        type: 'tools-doctor',
        diagnostics: [],
        totalCount: 0,
      }),
    ).toContain('No bootstrap diagnostics');
  });
});

describe('grouped history and config views', () => {
  it('renders suite-grouped history with standalone runs', () => {
    const out = text({
      type: 'history',
      sessions: [
        {
          id: 'STEP_1',
          tool: 'fit',
          startedAt: '2026-06-28T10:00:00.000Z',
          completedAt: '2026-06-28T10:00:00.000Z',
          score: 100,
          passed: true,
          durationMs: 100,
          showCommand: 'opensip sessions show STEP_1 --json',
        },
        {
          id: 'SOLO_1',
          tool: 'graph',
          startedAt: '2026-06-28T11:00:00.000Z',
          completedAt: '2026-06-28T11:00:00.000Z',
          score: 90,
          passed: true,
          durationMs: 200,
          showCommand: 'opensip sessions show SOLO_1 --json',
        },
      ],
      suiteGroups: [
        {
          suiteRunId: 'run-1',
          suiteName: 'security',
          sessions: [
            {
              id: 'STEP_1',
              tool: 'fit',
              startedAt: '2026-06-28T10:00:00.000Z',
              completedAt: '2026-06-28T10:00:00.000Z',
              score: 100,
              passed: true,
              durationMs: 100,
              showCommand: 'opensip sessions show STEP_1 --json',
            },
          ],
        },
      ],
    } as never);

    expect(out).toContain('Suite: security');
    expect(out).toContain('Standalone runs');
    expect(out).toContain('SOLO_1');
  });

  it('skips suite groups whose sessions fall outside the visible history window', () => {
    const sessions = Array.from({ length: 21 }, (_, index) => ({
      id: `S_${String(index)}`,
      tool: 'fit',
      startedAt: `2026-06-28T${String(10 + index).padStart(2, '0')}:00:00.000Z`,
      completedAt: `2026-06-28T${String(10 + index).padStart(2, '0')}:00:00.000Z`,
      score: 100,
      passed: true,
      durationMs: 100,
      showCommand: `opensip sessions show S_${String(index)} --json`,
    }));
    const out = text({
      type: 'history',
      sessions,
      suiteGroups: [
        {
          suiteRunId: 'hidden-run',
          suiteName: 'hidden',
          sessions: [sessions[20]],
        },
      ],
    } as never);

    expect(out).toContain('Run History (21 sessions)');
    expect(out).not.toContain('Suite: hidden');
  });

  it('renders graph lookup and config command results', () => {
    expect(
      text({
        type: 'graph-lookup',
        name: 'foo',
        resolutionMode: 'fast',
        matches: [{}, {}],
      } as never),
    ).toContain('fast catalog');

    expect(
      text({
        type: 'graph-lookup',
        name: 'foo',
        resolutionMode: 'exact',
        matches: [{}],
      } as never),
    ).toContain('1 occurrence');
    expect(
      text({
        type: 'graph-lookup',
        name: 'foo',
        resolutionMode: 'exact',
        matches: [{}, {}],
      } as never),
    ).not.toContain('fast catalog');

    const validate = text({
      type: 'config-validate',
      configPath: '/repo/opensip-cli.config.yml',
      namespaces: ['fitness', 'graph'],
      warnings: ['deprecated key'],
    } as never);
    expect(validate).toContain('Configuration valid');
    expect(validate).toContain('deprecated key');

    expect(
      text({
        type: 'config-schema',
        outPath: '/repo/schema.json',
      } as never),
    ).toContain('Wrote JSON Schema');

    expect(text({ type: 'config-schema' } as never)).toContain('Use --json');
  });
});
