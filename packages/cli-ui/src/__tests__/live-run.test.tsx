import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { ClockProvider } from '../clock.js';
import { LiveRun } from '../live-run.js';
import { ThemeProvider } from '../theme.js';

function mount(ui: React.ReactElement) {
  return render(
    <ThemeProvider>
      <ClockProvider>{ui}</ClockProvider>
    </ThemeProvider>,
  );
}

describe('<LiveRun>', () => {
  it('renders the loading frame', () => {
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={{ phase: 'loading' }}
        verbose={false}
        quiet
      />,
    );
    expect(lastFrame()).toContain('Working');
  });

  it('renders the error frame', () => {
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={{ phase: 'error', message: 'boom' }}
        verbose={false}
        quiet
      />,
    );
    expect(lastFrame()).toContain('boom');
  });

  it('omits verbose lines when verbose is false', () => {
    const { lastFrame } = mount(
      <LiveRun
        meta={{ title: 'Test Tool', description: 'Running test' }}
        surface={{ shape: 'pool', label: 'Working...' }}
        state={{
          phase: 'done',
          data: {
            summary: { passed: true, errors: 0, warnings: 0 },
            verboseLines: ['secret detail'],
          },
        }}
        verbose={false}
        quiet
      />,
    );
    expect(lastFrame()).not.toContain('secret detail');
  });
});
