import { renderImpactEntities } from './change-impact-entities.js';
import { renderImpactRisks } from './change-impact-risks.js';
import { renderImpactSummary, renderNoAuditState } from './change-impact-summary.js';
import { renderImpactTrust } from './change-impact-trust.js';
import { openCodePathsFunction } from './code-paths-panel.js';
import { el } from './el.js';
import { activateReportTab } from './tab-bar.js';

const CHANGE_IMPACT_HASH = /^#change-impact(?:\/([A-Za-z0-9_-]{1,128}))?$/u;
let hashListenerRegistered = false;

function hashRunId(): string | undefined {
  return CHANGE_IMPACT_HASH.exec(globalThis.location.hash || '')?.[1];
}

function requestedRunId(): string | undefined {
  const selection = typeof REPORT_SELECTION === 'undefined' ? null : REPORT_SELECTION;
  return hashRunId() ?? (selection?.view === 'change-impact' ? selection.runId : undefined);
}

function shouldActivate(): boolean {
  const hash = globalThis.location.hash || '';
  if (hash.length > 0) return CHANGE_IMPACT_HASH.test(hash);
  const selection = typeof REPORT_SELECTION === 'undefined' ? null : REPORT_SELECTION;
  return selection?.view === 'change-impact';
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
    renderNoAuditState(panel);
    if (shouldActivate()) activateReportTab('change-impact');
    return;
  }

  const requested = requestedRunId();
  const selected =
    changeImpactRuns.find((model) => model.runId === requested) ?? changeImpactRuns[0];
  if (!selected) return;
  const controls = el('div', { class: 'card change-impact-controls' }, [
    el('label', { for: 'change-impact-run-select', text: 'Audit run' }),
  ]);
  const select = el('select', {
    id: 'change-impact-run-select',
    'aria-label': 'Audit run',
  }) as HTMLSelectElement;
  changeImpactRuns.forEach((model) => {
    const option = el('option', {
      value: model.runId,
      text: `${model.completedAt} · ${model.runId}`,
    }) as HTMLOptionElement;
    option.selected = model.runId === selected.runId;
    select.append(option);
  });
  controls.append(select);
  if (requested && requested !== selected.runId) {
    controls.append(
      el('p', {
        class: 'text-muted change-impact-selection-fallback',
        text: `Requested run ${requested} is unavailable; showing the latest stored audit run.`,
      }),
    );
  }
  if (changeImpactOmittedRuns > 0) {
    controls.append(
      el('p', {
        class: 'text-muted',
        text: `${String(changeImpactOmittedRuns)} older audit run(s) omitted from this report.`,
      }),
    );
  }
  panel.append(controls);
  renderSelected(panel, selected);
  select.addEventListener('change', () => {
    const next = changeImpactRuns.find((model) => model.runId === select.value);
    if (!next) return;
    renderSelected(panel, next);
    updateHash(next.runId);
  });
  if (shouldActivate()) {
    activateReportTab('change-impact');
    updateHash(selected.runId);
  }
}
