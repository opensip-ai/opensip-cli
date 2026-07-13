/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Offline-render guarantee for the Graph view.
 *
 * Playwright is not part of this package's toolchain, so rather than boot a
 * real browser this test asserts the offline property at the artifact
 * level: a generated report inlines the Cytoscape renderer and the
 * projected view-model with ZERO external `<script src>` references, so it
 * renders the Graph view with the network disabled ("open an archived
 * report on a plane"). The only permitted external reference is the Google
 * Fonts stylesheet `<link>` the report already carried before this work.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { GraphCatalog } from '@opensip-cli/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', '..', 'cli', 'dist', 'index.js');

interface ReviewBriefProjection {
  readonly topRisks: readonly {
    readonly file: string;
    readonly message: string;
  }[];
  readonly recommendedActions: readonly {
    readonly message: string;
  }[];
}

interface AuditOutcome {
  readonly exitCode: number;
  readonly data: {
    readonly runId: string;
    readonly reviewBrief: ReviewBriefProjection;
    readonly steps: readonly {
      readonly command: string;
      readonly verification?: {
        readonly coverage: string;
        readonly fullyVerified: boolean;
      };
    }[];
  };
}

interface ReportOutcome {
  readonly type: 'report';
  readonly path: string;
  readonly opened: boolean;
}

interface BootResult {
  readonly activateReportTab: (id: string) => boolean;
}

interface IntegratedReportFixture {
  readonly audit: AuditOutcome;
  readonly exactHtml: string;
  readonly mismatchedHtml: string;
}

let integratedFixture: IntegratedReportFixture;
let projectRoot: string;

function loadFixture(): GraphCatalog {
  const candidates = [
    join(HERE, 'fixtures', 'catalog-small.json'),
    join(HERE, '..', '..', 'src', '__tests__', 'fixtures', 'catalog-small.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as GraphCatalog;
    } catch {
      // next
    }
  }
  throw new Error('catalog-small.json fixture not found');
}

function git(args: readonly string[]): void {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function cliEnv(): NodeJS.ProcessEnv {
  const home = join(projectRoot, '.home');
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    OPENSIP_NO_UPDATE: '1',
    NO_UPDATE_NOTIFIER: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
    OPENSIP_PROFILING: '0',
  };
}

function runCli(args: readonly string[], allowedExitCodes: readonly number[] = [0]): string {
  const result = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: projectRoot,
    env: cliEnv(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.signal !== null) {
    throw new Error(`opensip ${args.join(' ')} terminated by ${result.signal}`);
  }
  const status = result.status ?? -1;
  if (!allowedExitCodes.includes(status)) {
    throw new Error(
      `opensip ${args.join(' ')} exited ${String(status)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function writeProjectFixture(): void {
  mkdirSync(join(projectRoot, '.home'), { recursive: true });
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  mkdirSync(join(projectRoot, 'opensip-cli/fit/checks'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'dashboard-audit-report-fixture', private: true }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'Node16',
          moduleResolution: 'Node16',
          target: 'ES2022',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(projectRoot, 'opensip-cli.config.yml'),
    [
      'schemaVersion: 1',
      'targets:',
      '  src:',
      '    description: integration source',
      '    languages: [typescript]',
      '    concerns: [backend]',
      '    include: ["src/**/*.ts"]',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(projectRoot, 'src/change.ts'),
    [
      'export function changed(value: number): number {',
      '  return value + 1;',
      '}',
      'export function caller(): number {',
      '  return changed(1);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  git(['init', '-q']);
  git(['config', 'user.email', 'dashboard-integration@example.test']);
  git(['config', 'user.name', 'Dashboard Integration']);
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);

  // Bare eval is an intentional, deterministic security finding for the
  // built-in audit's agent-risk fitness recipe. Keep the token inside fixture
  // text so this test file itself is not a no-eval finding.
  writeFileSync(
    join(projectRoot, 'src/change.ts'),
    [
      'export function changed(value: number): number {',
      `  return ${'eval'}("String(value + 2)").length;`,
      '}',
      'export function caller(): number {',
      '  return changed(1);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
}

function reportHtml(): string {
  const outcome = JSON.parse(runCli(['--no-cloud', 'report', '--no-open', '--json'])) as
    ReportOutcome | { readonly data: ReportOutcome };
  const report = 'data' in outcome ? outcome.data : outcome;
  const expectedPath = join(projectRoot, 'opensip-cli', '.runtime', 'reports', 'latest.html');
  if (report.type !== 'report' || report.path !== expectedPath || report.opened) {
    throw new Error(`Unexpected report result: ${JSON.stringify(report)}`);
  }
  return readFileSync(report.path, 'utf8');
}

function createIntegratedFixture(): IntegratedReportFixture {
  writeProjectFixture();
  const auditText = runCli(
    ['--no-cloud', 'audit', '--files', 'src/change.ts', '--json', '--cwd', projectRoot],
    [0, 1, 2],
  );
  const audit = JSON.parse(auditText) as AuditOutcome;
  if (
    !audit.data?.runId ||
    audit.data.steps.length !== 3 ||
    audit.exitCode < 0 ||
    audit.data.reviewBrief.topRisks.length === 0 ||
    audit.data.reviewBrief.recommendedActions.length === 0
  ) {
    throw new Error(`Audit did not persist the expected review evidence: ${auditText}`);
  }
  const exactHtml = reportHtml();

  // Advance the current graph catalog without re-running audit. The second
  // report must retain the audit's linked impact projection while refusing to
  // use that stale identity for Code Paths navigation.
  writeFileSync(
    join(projectRoot, 'src/change.ts'),
    [
      'export function changed(value: number): number {',
      '  return value + 3;',
      '}',
      'export function caller(): number {',
      '  return changed(2);',
      '}',
      'export function later(): number {',
      '  return caller();',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  runCli(['--no-cloud', 'graph', '--json', '--cwd', projectRoot]);
  const mismatchedHtml = reportHtml();
  return { audit, exactHtml, mismatchedHtml };
}

function bootDashboard(html: string): BootResult {
  globalThis.history.replaceState(null, '', '/latest.html');
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/iu, '')
    .replace(/<\/html>[\s\S]*$/iu, '');
  const scripts = [...document.querySelectorAll('script')];
  let source = '';
  for (const script of scripts) {
    const type = script.getAttribute('type');
    if (type && type !== 'text/javascript') continue;
    if (script.textContent) source += `\n${script.textContent}`;
  }
  source += '\nreturn { activateReportTab };';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: the built CLI's self-contained local report.
  return new Function(source).call(globalThis) as BootResult;
}

function changeImpactPanel(html: string): HTMLElement {
  const boot = bootDashboard(html);
  if (!boot.activateReportTab('change-impact')) {
    throw new Error('Generated report did not register the Change Impact tab.');
  }
  const panel = document.querySelector<HTMLElement>('#panel-change-impact');
  if (!panel) throw new Error('Generated report did not render the Change Impact panel.');
  return panel;
}

function factValue(panel: HTMLElement, label: string): string | undefined {
  const term = [...panel.querySelectorAll('dt')].find(
    (candidate) => candidate.textContent === label,
  );
  return term?.nextElementSibling?.textContent ?? undefined;
}

beforeAll(() => {
  if (!existsSync(DIST_CLI)) {
    throw new Error(
      `Built CLI missing at ${DIST_CLI}. Run pnpm build before this integration test.`,
    );
  }
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-dashboard-audit-')));
  integratedFixture = createIntegratedFixture();
}, 360_000);

afterAll(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

describe('Graph view — offline render guarantee', () => {
  const html = generateDashboardHtml({ sessions: [], graphCatalog: loadFixture() });

  it('inlines the Cytoscape renderer (no CDN fetch)', () => {
    expect(html).toContain('cytoscape');
    expect(html).toContain('cytoscapeDagre');
  });

  it('embeds the projected graph-view-model blob', () => {
    expect(html).toContain('id="graph-view-model"');
  });

  it('registers the Graph view', () => {
    // The view registers from the typed client bundle (L4) — esbuild emits
    // double-quoted object keys/values, so the marker is the bundled form.
    expect(html).toContain('id: "graph"');
    expect(html).toContain('code-paths-graph-canvas');
  });

  it('has no external <script src> references (renders fully offline)', () => {
    const scriptSrc = /<script[^>]*\ssrc=["'][^"']+["']/gi;
    const matches = html.match(scriptSrc) ?? [];
    expect(matches).toHaveLength(0);
  });

  it('has no cytoscape CDN URL', () => {
    expect(/https?:\/\/[^"']*cytoscape/i.test(html)).toBe(false);
  });
});

describe('Change Impact — built audit to offline report integration', () => {
  it('renders the persisted run, trust, counts, path, risk, and action without network scripts', () => {
    const { audit, exactHtml } = integratedFixture;
    expect(exactHtml.match(/<script[^>]*\ssrc=["'][^"']+["']/giu) ?? []).toHaveLength(0);

    const panel = changeImpactPanel(exactHtml);
    const text = panel.textContent ?? '';
    const graphStep = audit.data.steps.find((step) => step.command === 'impact');
    const risk = audit.data.reviewBrief.topRisks[0];
    const action = audit.data.reviewBrief.recommendedActions[0];
    if (!graphStep?.verification || !risk || !action) {
      throw new Error('Audit fixture lost its graph verification, risk, or action projection.');
    }
    expect(document.querySelector<HTMLSelectElement>('#change-impact-run-select')?.value).toBe(
      audit.data.runId,
    );
    expect(text).toContain(`Run ${audit.data.runId}`);
    expect(text).toContain('Stored impact evidence is available.');
    expect(factValue(panel, 'Coverage')).toBe(graphStep.verification.coverage);
    expect(factValue(panel, 'Catalog qualification')).toBe('matching');
    expect(text).toContain(
      graphStep.verification.fullyVerified
        ? 'Fully verified for the stored scope.'
        : 'Not fully verified; inspect uncertainties before making coverage claims.',
    );
    expect(text).toContain('src/change.ts');
    expect(text).toContain(risk.message);
    expect(text).toContain(action.message);
    const changedFiles = [...panel.querySelectorAll('.change-impact-count')].find((card) =>
      card.textContent?.includes('Changed files'),
    );
    expect(changedFiles?.querySelector('strong')?.textContent).toMatch(/^1 retained/u);
    expect(panel.querySelector('.change-impact-risk')).not.toBeNull();
    expect(panel.querySelector('button.fc-action')).not.toBeNull();
  });

  it('keeps stored impact visible but disables drilldown after the current catalog changes', () => {
    const { audit, mismatchedHtml } = integratedFixture;
    const panel = changeImpactPanel(mismatchedHtml);
    const text = panel.textContent ?? '';
    const risk = audit.data.reviewBrief.topRisks[0];
    if (!risk) throw new Error('Audit fixture lost its persisted risk projection.');
    expect(text).toContain(`Run ${audit.data.runId}`);
    expect(text).toContain('Stored impact evidence is available.');
    expect(factValue(panel, 'Catalog qualification')).toBe('mismatched');
    expect(text).toContain('src/change.ts');
    expect(text).toContain(risk.message);
    expect(text).toContain('Code Paths unavailable: stored and current catalogs do not match.');
    expect(panel.querySelector('button.fc-action')).toBeNull();
  });
});
