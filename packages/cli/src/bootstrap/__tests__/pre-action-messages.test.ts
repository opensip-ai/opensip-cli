/**
 * Unit coverage for the pure preAction message formatters. These are
 * deterministic string builders (no IO/exit); the hook owns the side
 * effects. Covers the CLI-too-old message (the config-version seam this
 * release leans on) and both branches of the no-project message.
 */

import { describe, expect, it } from 'vitest';

import {
  formatCliTooOldMessage,
  formatNoProjectFoundMessage,
} from '../pre-action-messages.js';

describe('formatCliTooOldMessage', () => {
  it('renders the upgrade-the-CLI message with the version mismatch', () => {
    const msg = formatCliTooOldMessage({ root: '/p', configVersion: 4, cliVersion: 2 });
    expect(msg).toContain('newer schema than your CLI supports');
    expect(msg).toContain('Project:        /p');
    expect(msg).toContain('Config schema:  v4');
    expect(msg).toContain('CLI supports:   v2');
    // Direction-correct: upgrade the CLI, NOT "run migrate".
    expect(msg).toContain('npm install -g opensip-tools@latest');
    expect(msg).not.toContain('migrate');
  });
});

describe('formatNoProjectFoundMessage', () => {
  it('renders a single-field JSON error when jsonOutput is true', () => {
    const out = formatNoProjectFoundMessage('/some/dir', true);
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toContain('No opensip-tools.config.yml found');
    expect(parsed.error).toContain('/some/dir');
    expect(parsed.error).toContain('opensip-tools init');
  });

  it('renders the human walked-up explainer with the init hint when jsonOutput is false', () => {
    const out = formatNoProjectFoundMessage('/some/dir', false);
    expect(out).toContain('No opensip-tools project found');
    expect(out).toContain('Searched from: /some/dir');
    expect(out).toContain('Walked up to: /');
    expect(out).toContain('opensip-tools init');
    // Human path is not JSON.
    expect(() => JSON.parse(out)).toThrow();
  });
});
