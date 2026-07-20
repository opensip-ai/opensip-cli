/**
 * Top-level tab-bar click handler.
 *
 * Wires the `#tab-bar` click event to toggle the `active` class on
 * both the `.tab` headers and the `.tab-panel` containers.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

export interface ActivateReportTabOptions {
  readonly focus?: boolean;
}

/** Activate one registered top-level tab and its panel as one ARIA state change. */
export function activateReportTab(id: string, options: ActivateReportTabOptions = {}): boolean {
  const tab = document.querySelector<HTMLElement>('.tab[data-tab="' + id + '"]');
  const panel = document.querySelector<HTMLElement>('#panel-' + id);
  if (!tab || !panel) return false;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll<HTMLElement>('.tab').forEach((candidate) => {
    const active = candidate === tab;
    candidate.setAttribute('aria-selected', String(active));
    candidate.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((candidate) => {
    candidate.hidden = candidate !== panel;
  });
  tab.classList.add('active');
  panel.classList.add('active');
  panel.hidden = false;
  if (options.focus) tab.focus();
  if (id !== 'code-paths' && globalThis.location.hash.startsWith('#code-paths/')) {
    replaceHash(globalThis.location.href.split('#', 1)[0] ?? '');
  }
  return true;
}

export function replaceHash(hash: string): void {
  try {
    globalThis.history.replaceState(null, '', hash);
  } catch {
    // @swallow-ok file/sandbox history restrictions must not break report navigation.
  }
}

function syncTopLevelHash(id: string): void {
  if (id === 'change-impact') {
    const runId = document.querySelector<HTMLSelectElement>('#change-impact-run-select')?.value;
    replaceHash('#change-impact' + (runId ? '/' + encodeURIComponent(runId) : ''));
    return;
  }
  if (/^#change-impact(?:\/[A-Za-z0-9_-]{1,128})?$/u.test(globalThis.location.hash)) {
    replaceHash(globalThis.location.href.split('#', 1)[0] ?? '');
  }
}

const tabBar = document.querySelector<HTMLElement>('#tab-bar');
tabBar?.addEventListener('click', (event) => {
  const tab = (event.target as Element | null)?.closest<HTMLElement>('.tab');
  const id = tab?.dataset.tab;
  if (!id || !activateReportTab(id)) return;
  syncTopLevelHash(id);
});

tabBar?.addEventListener('keydown', (event) => {
  if (!(event instanceof KeyboardEvent)) return;
  const current = (event.target as Element | null)?.closest<HTMLElement>('.tab');
  if (!current) return;
  const tabs = [...tabBar.querySelectorAll<HTMLElement>('.tab')];
  const index = tabs.indexOf(current);
  if (index < 0) return;
  let next: number | undefined;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next === undefined) return;
  event.preventDefault();
  const id = tabs[next]?.dataset.tab;
  if (id && activateReportTab(id, { focus: true })) syncTopLevelHash(id);
});
