/* eslint-disable unicorn/filename-case -- React component test files mirror PascalCase component filenames */
import { type CheckOutput } from '@opensip-tools/contracts';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { Findings } from '../../../ui/components/Findings.js';
import { ThemeProvider } from '../../../ui/theme.js';

const sampleChecks: CheckOutput[] = [
  {
    checkSlug: 'no-console-log',
    passed: false,
    violationCount: 2,
    durationMs: 5,
    findings: [
      {
        ruleId: 'no-console-log',
        severity: 'error',
        message: 'console.log found in production code',
        filePath: 'src/index.ts',
        line: 42,
      },
      {
        ruleId: 'no-console-log',
        severity: 'warning',
        message: 'console.warn may be acceptable but review usage',
        filePath: 'src/utils.ts',
        line: 10,
        suggestion: 'Use a proper logger instead',
      },
    ],
  },
];

describe('Findings', () => {
  it('renders the check slug', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Findings checks={sampleChecks} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('no-console-log');
  });

  it('renders violation messages', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Findings checks={sampleChecks} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('console.log found in production code');
    expect(output).toContain('console.warn may be acceptable but review usage');
  });

  it('renders file locations', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Findings checks={sampleChecks} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('src/index.ts:42');
    expect(output).toContain('src/utils.ts:10');
  });

  it('renders suggestions when provided', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Findings checks={sampleChecks} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('Use a proper logger instead');
  });

  it('renders total finding count in header', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Findings checks={sampleChecks} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    // total = errorCount + warningCount = 1 + 1 = 2
    expect(output).toContain('Findings');
    expect(output).toContain('(2)');
  });

  it('renders check-level errors', () => {
    const checks: CheckOutput[] = [
      {
        checkSlug: 'broken-check',
        passed: false,
        violationCount: 0,
        durationMs: 0,
        findings: [],
        error: 'Timed out after 60s',
      },
    ];

    const { lastFrame } = render(
      <ThemeProvider>
        <Findings checks={checks} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('broken-check');
    expect(output).toContain('Timed out after 60s');
  });

  it('skips checks with no findings', () => {
    const checks: CheckOutput[] = [
      {
        checkSlug: 'clean-check',
        passed: true,
        violationCount: 0,
        durationMs: 0,
        findings: [],
      },
      ...sampleChecks,
    ];

    const { lastFrame } = render(
      <ThemeProvider>
        <Findings checks={checks} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).not.toContain('clean-check');
    expect(output).toContain('no-console-log');
  });
});
