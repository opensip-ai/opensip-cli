/**
 * Unit coverage for the pure preAction message formatters. These are
 * deterministic string builders (no IO/exit); the hook owns the side
 * effects. Covers the CLI-too-old message (the config-version seam this
 * release leans on) and both branches of the no-project message.
 */

import { describe, expect, it } from 'vitest';

import { formatCliTooOldMessage, formatNoProjectFoundMessage } from '../pre-action-messages.js';

describe('formatCliTooOldMessage', () => {
  it('renders the upgrade-the-CLI message with the version mismatch', () => {
    const msg = formatCliTooOldMessage({ root: '/p', configVersion: 4, cliVersion: 2 });
    expect(msg).toContain('newer schema than your CLI supports');
    expect(msg).toContain('Project:        /p');
    expect(msg).toContain('Config schema:  v4');
    expect(msg).toContain('CLI supports:   v2');
    // Direction-correct: upgrade the CLI, NOT "run migrate".
    expect(msg).toContain('curl -fsSL https://opensip.ai/cli/install.sh | bash');
    expect(msg).not.toContain('migrate');
  });
});

describe('formatNoProjectFoundMessage', () => {
  // 2.12.0 (§4.7): the --json shape is no longer rendered here — a no-project
  // failure is a BootstrapError the top-level boundary turns into a structured
  // bootstrap.error CommandOutcome. This formatter is the human path only.
  it('renders the human walked-up explainer with the init hint', () => {
    const out = formatNoProjectFoundMessage('/some/dir');
    expect(out).toContain('No OpenSIP CLI project found');
    expect(out).toContain('Searched from: /some/dir');
    expect(out).toContain('Walked up to: /');
    expect(out).toContain('opensip init');
    // Human path is not JSON.
    expect(() => JSON.parse(out)).toThrow();
  });
});
