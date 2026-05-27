import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { CloudReportStatus } from '../../../ui/components/CloudReportStatus.js';

describe('CloudReportStatus', () => {
  it('renders success line with finding & run count', () => {
    const { lastFrame } = render(
      <CloudReportStatus
        url="https://cloud.example/r/abc"
        findingCount={5}
        runCount={42}
        success
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Reported to');
    expect(out).toContain('https://cloud.example/r/abc');
    expect(out).toContain('5 findings from 42 checks');
    expect(out).toContain('✔');
  });

  it('renders failure line with optional error', () => {
    const { lastFrame } = render(
      <CloudReportStatus
        url="https://x.example"
        findingCount={0}
        runCount={0}
        success={false}
        error="boom"
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Failed to report');
    expect(out).toContain('boom');
    expect(out).toContain('✗');
  });

  it('shows partial-report when some chunks succeeded', () => {
    const { lastFrame } = render(
      <CloudReportStatus
        url="https://x.example"
        findingCount={0}
        runCount={0}
        success={false}
        chunksTotal={4}
        chunksSucceeded={2}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Partially reported');
    expect(out).toContain('2/4 chunks');
  });

  it('shows chunk detail when chunksTotal > 1 and success', () => {
    const { lastFrame } = render(
      <CloudReportStatus
        url="https://x.example"
        findingCount={3}
        runCount={2}
        success
        chunksTotal={5}
        chunksSucceeded={5}
      />,
    );
    expect(lastFrame()).toContain('5/5 chunks');
  });

  it('omits chunk detail when chunksTotal is 1 or missing', () => {
    const { lastFrame } = render(
      <CloudReportStatus
        url="https://x.example"
        findingCount={0}
        runCount={0}
        success
        chunksTotal={1}
      />,
    );
    expect(lastFrame() ?? '').not.toContain('chunks');
  });
});
