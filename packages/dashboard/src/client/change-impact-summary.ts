import { formatDuration } from '@opensip-cli/format';

import { CHANGE_IMPACT_CLIENT_CAPS, boundClientRows } from './change-impact-bounds.js';
import { el } from './el.js';

const MUTED_CLASS = 'text-muted';

function countCard(
  label: string,
  value: number,
  backendOmitted = 0,
  reportOmitted = 0,
): HTMLElement {
  const details = [`${String(value)} retained`];
  if (backendOmitted > 0) details.push(`${String(backendOmitted)} backend omitted`);
  if (reportOmitted > 0) details.push(`${String(reportOmitted)} report omitted`);
  return el('div', { class: 'card change-impact-count' }, [
    el('div', { class: MUTED_CLASS, text: label }),
    el('strong', { text: details.join(', ') }),
  ]);
}

interface ImpactListOptions {
  readonly backendOmitted: number;
  readonly clientCap: number;
  readonly container: HTMLElement;
  readonly reportOmitted: number;
  readonly rows: readonly string[];
  readonly title: string;
}

function appendList(options: ImpactListOptions): void {
  const { backendOmitted, clientCap, container, reportOmitted, rows, title } = options;
  const section = el('section', { class: 'card change-impact-list-card' }, [
    el('h3', { text: title }),
  ]);
  const bounded = boundClientRows(rows, clientCap);
  if (bounded.rows.length === 0)
    section.append(el('div', { class: 'empty', text: 'No stored rows.' }));
  else {
    const list = el('ul', { class: 'change-impact-list' });
    bounded.rows.forEach((row) => list.append(el('li', { text: row })));
    section.append(list);
  }
  if (backendOmitted > 0)
    section.append(
      el('div', {
        class: MUTED_CLASS,
        text: `${String(backendOmitted)} additional row(s) omitted by the backend projection.`,
      }),
    );
  if (reportOmitted > 0)
    section.append(
      el('div', {
        class: MUTED_CLASS,
        text: `${String(reportOmitted)} additional row(s) omitted by the report budget.`,
      }),
    );
  if (bounded.omitted > 0)
    section.append(
      el('div', {
        class: MUTED_CLASS,
        text: `${String(bounded.omitted)} additional row(s) omitted by the defensive client limit.`,
      }),
    );
  container.append(section);
}

export function renderImpactSummary(container: HTMLElement, model: ChangeImpactViewModel): void {
  const verdict = model.verdict;
  const scope = model.scope;
  const scopeRef = scope?.ref ? ` from ${scope.ref}` : '';
  const header = el('header', { class: `card change-impact-hero state-${verdict}` }, [
    el('div', {
      class: `badge change-impact-verdict-${verdict}`,
      text: verdict.toUpperCase(),
    }),
    el('h2', { text: 'Change Impact' }),
    el('div', {
      class: MUTED_CLASS,
      text: `Run ${model.runId} · ${scope?.mode ?? 'unknown'} scope${scopeRef} · ${formatDuration(model.durationMs)}`,
    }),
  ]);
  if (scope?.notice) header.append(el('p', { text: scope.notice }));
  container.append(header);

  if (!model.evidence) return;
  const evidence = model.evidence;
  const counts = el('div', { class: 'change-impact-counts' });
  counts.append(
    countCard(
      'Changed files',
      evidence.changedFiles.length,
      evidence.backendOmitted.changedFiles,
      model.reportOmitted.changedFiles,
    ),
    countCard(
      'Changed functions',
      evidence.changedFunctions.length,
      evidence.backendOmitted.changedFunctions,
      model.reportOmitted.changedFunctions,
    ),
    countCard(
      'Impacted functions',
      evidence.impactedFunctions.length,
      evidence.backendOmitted.impactedFunctions,
      model.reportOmitted.impactedFunctions,
    ),
    countCard(
      'Impacted files',
      evidence.impactedFiles.length,
      evidence.backendOmitted.impactedFiles,
      model.reportOmitted.impactedFiles,
    ),
    countCard(
      'Impacted packages',
      evidence.impactedPackages.length,
      evidence.backendOmitted.impactedPackages,
      model.reportOmitted.impactedPackages,
    ),
  );
  container.append(counts);
  appendList({
    backendOmitted: evidence.backendOmitted.changedFiles,
    clientCap: CHANGE_IMPACT_CLIENT_CAPS.changedFiles,
    container,
    reportOmitted: model.reportOmitted.changedFiles,
    rows: evidence.changedFiles,
    title: 'Changed files',
  });
  appendList({
    backendOmitted: evidence.backendOmitted.impactedFiles,
    clientCap: CHANGE_IMPACT_CLIENT_CAPS.impactedFiles,
    container,
    reportOmitted: model.reportOmitted.impactedFiles,
    rows: evidence.impactedFiles,
    title: 'Impacted files',
  });
}

export function renderNoAuditState(container: HTMLElement, omittedRuns = 0): void {
  if (omittedRuns > 0) {
    container.append(
      el('div', { class: 'empty change-impact-empty' }, [
        el('h3', { text: 'Stored audit run details are unavailable.' }),
        el('p', {
          text: `${String(omittedRuns)} stored audit run(s) omitted from this report.`,
        }),
      ]),
    );
    return;
  }
  container.append(
    el('div', { class: 'empty change-impact-empty' }, [
      el('h3', { text: 'No stored audit run is available.' }),
      el('p', {
        text: 'Run opensip audit --open to create and inspect changed-code evidence.',
      }),
    ]),
  );
}
