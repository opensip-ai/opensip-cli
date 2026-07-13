import { formatDuration } from '@opensip-cli/format';

import { el } from './el.js';

function countCard(label: string, value: number, omitted = 0): HTMLElement {
  const detail =
    omitted > 0 ? `${String(value)} retained, ${String(omitted)} omitted` : String(value);
  return el('div', { class: 'card change-impact-count' }, [
    el('div', { class: 'text-muted', text: label }),
    el('strong', { text: detail }),
  ]);
}

function appendList(
  container: HTMLElement,
  title: string,
  rows: readonly string[],
  omitted: number,
): void {
  const section = el('div', { class: 'card' }, [el('h4', { text: title })]);
  if (rows.length === 0) section.append(el('div', { class: 'empty', text: 'No stored rows.' }));
  else {
    const list = el('ul', { class: 'change-impact-list' });
    rows.forEach((row) => list.append(el('li', { text: row })));
    section.append(list);
  }
  if (omitted > 0)
    section.append(
      el('div', {
        class: 'text-muted',
        text: `${String(omitted)} additional row(s) omitted.`,
      }),
    );
  container.append(section);
}

export function renderImpactSummary(container: HTMLElement, model: ChangeImpactViewModel): void {
  const verdict = model.verdict;
  const scope = model.scope;
  const scopeRef = scope?.ref ? ` from ${scope.ref}` : '';
  const header = el('div', { class: 'card change-impact-hero' }, [
    el('div', {
      class: `badge change-impact-verdict-${verdict}`,
      text: verdict.toUpperCase(),
    }),
    el('h2', { text: 'Change Impact' }),
    el('div', {
      class: 'text-muted',
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
      evidence.backendOmitted.changedFiles + model.reportOmitted.changedFiles,
    ),
    countCard(
      'Changed functions',
      evidence.changedFunctions.length,
      evidence.backendOmitted.changedFunctions + model.reportOmitted.changedFunctions,
    ),
    countCard(
      'Impacted functions',
      evidence.impactedFunctions.length,
      evidence.backendOmitted.impactedFunctions + model.reportOmitted.impactedFunctions,
    ),
    countCard(
      'Impacted files',
      evidence.impactedFiles.length,
      evidence.backendOmitted.impactedFiles + model.reportOmitted.impactedFiles,
    ),
    countCard(
      'Impacted packages',
      evidence.impactedPackages.length,
      evidence.backendOmitted.impactedPackages + model.reportOmitted.impactedPackages,
    ),
  );
  container.append(counts);
  appendList(
    container,
    'Changed files',
    evidence.changedFiles,
    evidence.backendOmitted.changedFiles + model.reportOmitted.changedFiles,
  );
  appendList(
    container,
    'Impacted files',
    evidence.impactedFiles,
    evidence.backendOmitted.impactedFiles + model.reportOmitted.impactedFiles,
  );
}

export function renderNoAuditState(container: HTMLElement): void {
  container.append(
    el('div', { class: 'empty change-impact-empty' }, [
      el('h3', { text: 'No stored audit run is available.' }),
      el('p', {
        text: 'Run opensip audit --open to create and inspect changed-code evidence.',
      }),
    ]),
  );
}
