import { renderImpactEntities } from './change-impact-entities.js';
import { renderImpactRisks } from './change-impact-risks.js';
import { renderImpactSummary, renderNoAuditState } from './change-impact-summary.js';
import { renderImpactTrust } from './change-impact-trust.js';
import { openCodePathsFunction } from './code-paths-panel.js';
import { el } from './el.js';
import { activateReportTab } from './tab-bar.js';

const CHANGE_IMPACT_HASH = /^#change-impact(?:\/([A-Za-z0-9_-]{1,128}))?$/u;
const CHANGE_IMPACT_VIEW = 'change-impact';
let hashListenerRegistered = false;

function hashRunId(): string | undefined {
  return CHANGE_IMPACT_HASH.exec(globalThis.location.hash || '')?.[1];
}

function requestedRunId(): string | undefined {
  const selection = typeof REPORT_SELECTION === 'undefined' ? null : REPORT_SELECTION;
  return hashRunId() ?? (selection?.view === CHANGE_IMPACT_VIEW ? selection.runId : undefined);
}

function shouldActivate(): boolean {
  const hash = globalThis.location.hash || '';
  if (hash.length > 0) return CHANGE_IMPACT_HASH.test(hash);
  const selection = typeof REPORT_SELECTION === 'undefined' ? null : REPORT_SELECTION;
  return selection?.view === CHANGE_IMPACT_VIEW;
}

function updateHash(runId: string): void {
  try {
    globalThis.history.replaceState(null, '', `#change-impact/${encodeURIComponent(runId)}`);
  } catch {
    // @swallow-ok static-file/sandbox history restrictions must not break rendering.
  }
}

function renderSection(
  panel: HTMLElement,
  title: string,
  render: (container: HTMLElement) => void,
): void {
  const host = el('section', { class: 'change-impact-section' });
  try {
    render(host);
  } catch {
    host.replaceChildren(
      el('div', {
        class: 'card',
        text: `${title} is unavailable because its stored evidence could not be rendered.`,
      }),
    );
  }
  panel.append(host);
}

function renderSelected(panel: HTMLElement, model: ChangeImpactViewModel): void {
  panel.querySelectorAll('.change-impact-section').forEach((section) => section.remove());
  renderSection(panel, 'Impact summary', (host) => renderImpactSummary(host, model));
  renderSection(panel, 'Evidence quality', (host) => renderImpactTrust(host, model));
  renderSection(panel, 'Review risks', (host) => renderImpactRisks(host, model));
  renderSection(panel, 'Impact entities', (host) =>
    renderImpactEntities(host, model, openCodePathsFunction),
  );
}

function selectionAnnouncement(model: ChangeImpactViewModel): string {
  return `Showing audit run ${model.runId}: ${model.verdict}, ${model.availability.replaceAll('-', ' ')} evidence.`;
}

function omittedRunsNotice(): HTMLElement | undefined {
  if (changeImpactOmittedRuns <= 0) return undefined;
  return el('p', {
    class: 'text-muted change-impact-omitted-runs',
    text: `${String(changeImpactOmittedRuns)} stored audit run(s) omitted from this report.`,
  });
}

export function renderChangeImpact(): void {
  const panel = document.querySelector<HTMLElement>('#panel-change-impact');
  if (!panel) return;
  if (!hashListenerRegistered) {
    globalThis.addEventListener('hashchange', () => {
      if (
        document.querySelector('#panel-change-impact') === panel &&
        CHANGE_IMPACT_HASH.test(globalThis.location.hash || '')
      ) {
        renderChangeImpact();
      }
    });
    hashListenerRegistered = true;
  }
  panel.replaceChildren();
  if (changeImpactRuns.length === 0) {
    renderNoAuditState(panel, changeImpactOmittedRuns);
    if (shouldActivate()) activateReportTab(CHANGE_IMPACT_VIEW);
    return;
  }

  const requested = requestedRunId();
  const exactMatch =
    requested === undefined
      ? undefined
      : changeImpactRuns.find((model) => model.runId === requested);
  // Host-embedded exact selection must never fall back to another Run.
  // Unselected reports (no runId) keep the previous "first available" default.
  const hostSelection = typeof REPORT_SELECTION === 'undefined' ? null : REPORT_SELECTION;
  const exactHostSelection =
    hostSelection?.view === CHANGE_IMPACT_VIEW && typeof hostSelection.runId === 'string';
  if (exactHostSelection && requested && exactMatch === undefined) {
    panel.append(
      el('div', {
        class: 'card change-impact-selection-unavailable',
        text: `Requested run ${requested} is not available in this report's Change Impact projection. Inspect with: opensip runs show ${requested} --json`,
      }),
    );
    if (shouldActivate()) activateReportTab(CHANGE_IMPACT_VIEW);
    return;
  }
  const selected = exactMatch ?? changeImpactRuns[0];
  if (!selected) return;
  const controls = el('section', { class: 'card change-impact-controls' }, [
    el('label', { for: 'change-impact-run-select', text: 'Audit run' }),
  ]);
  const select = el('select', {
    id: 'change-impact-run-select',
    'aria-label': 'Audit run',
    'aria-describedby': 'change-impact-selection-status',
  }) as HTMLSelectElement;
  changeImpactRuns.forEach((model) => {
    const option = el('option', {
      value: model.runId,
      text: `${model.completedAt} · ${model.runId}`,
    }) as HTMLOptionElement;
    option.selected = model.runId === selected.runId;
    select.append(option);
  });
  const liveStatus = el('p', {
    id: 'change-impact-selection-status',
    class: 'text-muted change-impact-selection-status',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
    text: selectionAnnouncement(selected),
  });
  controls.append(select, liveStatus);
  const omission = omittedRunsNotice();
  if (omission) controls.append(omission);
  panel.append(controls);
  renderSelected(panel, selected);
  select.addEventListener('change', () => {
    const next = changeImpactRuns.find((model) => model.runId === select.value);
    if (!next) return;
    renderSelected(panel, next);
    liveStatus.textContent = selectionAnnouncement(next);
    updateHash(next.runId);
  });
  if (shouldActivate()) {
    activateReportTab(CHANGE_IMPACT_VIEW);
    updateHash(selected.runId);
  }
}
