/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Filter Observer dispatch — §10.3 / §10.6.
 *
 * Toggling a filter chip must call `render` exactly once on every
 * registered view, in registration order. This validates the
 * Subject/Observer wiring inside `notifyViews()`.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardFiltersJs } from '../persistence/dashboard/code-paths/filters.js';
import { dashboardPathUtilsJs } from '../persistence/dashboard/code-paths/path-utils.js';
import { dashboardViewsRegistryJs } from '../persistence/dashboard/code-paths/views-registry.js';

interface Env {
  notifyViews: () => void;
  views: { id: string; render: (...a: unknown[]) => void }[];
  filterState: { packages: Set<string>; kinds: Set<string>; includeTests: boolean };
  log: string[];
}

function loadEnv(): Env {
  const stubs = `
function el(tag, attrs, children) { return document.createElement(tag); }
let graphCatalog = { version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now', functions: {} };
let graphIndexes = { byBodyHash: new Map(), bySimpleName: new Map(), callees: new Map(), callers: new Map() };
const log = [];
function makeView(id) { return { id, label: id, render: () => log.push(id) }; }
`;
  const tail = `
// Containers in DOM so notifyViews can find them.
for (const id of ['hot','big','wide','coupling','untested','sccs','search']) {
  const c = document.createElement('div'); c.id = 'code-paths-view-' + id; document.body.appendChild(c);
  views.push(makeView(id));
}
return { notifyViews, views, filterState, log };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const factory = new Function(stubs + dashboardPathUtilsJs() + dashboardViewsRegistryJs() + dashboardFiltersJs() + tail);
  return factory() as Env;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('notifyViews — Observer dispatch', () => {
  it('calls render on every registered view, in registration order', () => {
    const env = loadEnv();
    env.log.length = 0;
    env.notifyViews();
    expect(env.log).toEqual(['hot', 'big', 'wide', 'coupling', 'untested', 'sccs', 'search']);
  });

  it('calls render exactly once per view per notify', () => {
    const env = loadEnv();
    env.log.length = 0;
    env.notifyViews();
    const counts = new Map<string, number>();
    for (const id of env.log) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [, c] of counts) expect(c).toBe(1);
  });
});
