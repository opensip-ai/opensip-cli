/* eslint-disable unicorn/filename-case -- React component test files mirror PascalCase component filenames */
import { ThemeProvider } from '@opensip-tools/cli-ui';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { ResultsTable } from '../../../ui/components/ResultsTable.js';

import type { TableRow } from '@opensip-tools/contracts';

const sampleRows: TableRow[] = [
  {
    check: 'no-console-log',
    status: 'FAIL',
    errors: 3,
    warnings: 1,
    validated: '42 files',
    ignored: 0,
    duration: '120ms',
    durationMs: 120,
  },
  {
    check: 'require-error-handling',
    status: 'PASS',
    errors: 0,
    warnings: 0,
    validated: '18 files',
    ignored: 2,
    duration: '80ms',
    durationMs: 80,
  },
];

describe('ResultsTable', () => {
  it('renders FAIL and PASS statuses', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ResultsTable rows={sampleRows} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('FAIL');
    expect(output).toContain('PASS');
  });

  it('renders check names', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ResultsTable rows={sampleRows} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('no-console-log');
    expect(output).toContain('require-error-handling');
  });

  it('renders column headers', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ResultsTable rows={sampleRows} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('Check');
    expect(output).toContain('Status');
    expect(output).toContain('Errors');
    expect(output).toContain('Warnings');
  });

  it('returns null for empty rows', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <ResultsTable rows={[]} />
      </ThemeProvider>,
    );

    // null render produces empty string
    expect(lastFrame()).toBe('');
  });

  it('sorts FAIL before PASS', () => {
    const rows: TableRow[] = [
      { check: 'pass-check', status: 'PASS', errors: 0, warnings: 0, validated: '1 files', ignored: 0, duration: '1ms', durationMs: 1 },
      { check: 'fail-check', status: 'FAIL', errors: 1, warnings: 0, validated: '1 files', ignored: 0, duration: '1ms', durationMs: 1 },
    ];

    const { lastFrame } = render(
      <ThemeProvider>
        <ResultsTable rows={rows} />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    const failIndex = output.indexOf('fail-check');
    const passIndex = output.indexOf('pass-check');
    expect(failIndex).toBeLessThan(passIndex);
  });
});
