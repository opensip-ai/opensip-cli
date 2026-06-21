/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Help drawer — opens with the active view's help content, closes on
 * × button, backdrop click, or Escape key. Only one drawer is on the
 * page at a time.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

interface Env {
  openHelpDrawer: (id: string) => void;
  views: {
    id: string;
    label: string;
    help?: { title: string; sections: { heading: string; body: string }[] };
  }[];
}

function loadEnv(): Env {
  // The views registry + help drawer (with `el`) now live in the typed client
  // bundle (L4) and are exposed as page globals; the bundle's help-drawer also
  // attaches its load-time Escape keydown handler. `var sessions = []` satisfies
  // checks.ts's load-time `computeCheckStats()` read.
  const shim = `
// jsdom does not implement requestAnimationFrame in all configurations;
// inline a synchronous shim so the drawer's open class is applied
// deterministically inside the test.
if (typeof requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (cb) => { cb(0); return 0; };
}
var sessions = [];
`;
  const seed = `
views.length = 0;
views.push({
  id: 'hot',
  label: 'Hot functions',
  help: {
    title: 'Hot functions',
    sections: [
      { heading: 'What this is', body: 'Functions ranked by inbound call count.' },
      { heading: 'Why you care', body: 'Hot functions are leverage points.' },
    ],
  },
  render() {},
});
views.push({ id: 'no-help', label: 'No help', render() {} });
return { openHelpDrawer, views };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  const factory = new Function(shim + DASHBOARD_CLIENT_BUNDLE + seed);
  return factory() as Env;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('help drawer', () => {
  it('opens with the view help title and renders every section', () => {
    const env = loadEnv();
    env.openHelpDrawer('hot');
    const drawer = document.querySelector('.help-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer!.querySelector('h3')!.textContent).toBe('Hot functions');
    // eslint-disable-next-line unicorn/prefer-spread -- NodeListOf spread requires lib.dom.iterable.
    const headings = Array.from(drawer!.querySelectorAll('h4')).map((h) => h.textContent);
    expect(headings).toEqual(['What this is', 'Why you care']);
    expect(drawer!.textContent).toContain('Functions ranked by inbound call count.');
  });

  it('does nothing for a view without a help block', () => {
    const env = loadEnv();
    env.openHelpDrawer('no-help');
    expect(document.querySelector('.help-drawer-overlay')).toBeNull();
  });

  it('closes via the × button', () => {
    const env = loadEnv();
    env.openHelpDrawer('hot');
    const closeBtn = document.querySelector<HTMLButtonElement>('.help-drawer-close')!;
    closeBtn.click();
    expect(document.querySelector('.help-drawer-overlay')).toBeNull();
  });

  it('closes when the Escape key is pressed', () => {
    const env = loadEnv();
    env.openHelpDrawer('hot');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.help-drawer-overlay')).toBeNull();
  });

  it('closes when the backdrop is clicked', () => {
    const env = loadEnv();
    env.openHelpDrawer('hot');
    const overlay = document.querySelector<HTMLElement>('.help-drawer-overlay')!;
    // Dispatch a click whose target is the overlay itself.
    const evt = new MouseEvent('click', { bubbles: true });
    overlay.dispatchEvent(evt);
    expect(document.querySelector('.help-drawer-overlay')).toBeNull();
  });

  it('only one drawer exists if open is called twice', () => {
    const env = loadEnv();
    env.openHelpDrawer('hot');
    env.openHelpDrawer('hot');
    expect(document.querySelectorAll('.help-drawer-overlay').length).toBe(1);
  });
});
