/* eslint-disable unicorn/filename-case -- React component test files mirror PascalCase component filenames */
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { Summary } from '../../../ui/components/Summary.js';
import { ThemeProvider } from '../../../ui/theme.js';

describe('Summary', () => {
  it('renders single-line summary with all stats', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Summary
          passed={120}
          failed={10}
          totalErrors={423}
          totalWarnings={227}
          totalIgnored={222}
          durationMs={8100}
        />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('120 Passed');
    expect(output).toContain('10 Failed');
    expect(output).toContain('423 Errors');
    expect(output).toContain('227 Warnings');
    expect(output).toContain('8.1s');
  });

  it('formats duration in ms when < 1000', () => {
    const { lastFrame } = render(
      <ThemeProvider>
        <Summary
          passed={1}
          failed={0}
          totalErrors={0}
          totalWarnings={0}
          totalIgnored={0}
          durationMs={500}
        />
      </ThemeProvider>,
    );

    const output = lastFrame()!;
    expect(output).toContain('500ms');
  });
});
