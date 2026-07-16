import { CHANGE_IMPACT_CLIENT_CAPS, boundClientRows } from './change-impact-bounds.js';
import { el } from './el.js';

const MUTED_CLASS = 'text-muted';

export type OpenCodePath = (
  identity: ChangeImpactFunctionModel & { readonly bodyHash: string },
) => void;

function navigationReason(
  value: ChangeImpactFunctionModel,
  hasNavigationCallback: boolean,
): string {
  if (value.navigation === 'available' && !hasNavigationCallback)
    return 'Code Paths unavailable: report navigation is not initialized.';
  if (value.navigation === 'ambiguous') return 'Code Paths unavailable: identity is ambiguous.';
  if (value.navigation === 'not-found')
    return 'Code Paths unavailable: identity is absent from the current catalog.';
  return 'Code Paths unavailable: stored and current catalogs do not match.';
}

interface FunctionTableOptions {
  readonly backendOmitted: number;
  readonly clientCap: number;
  readonly openCodePath?: OpenCodePath;
  readonly reportOmitted: number;
  readonly rows: readonly ChangeImpactFunctionModel[];
  readonly title: string;
}

function functionTable(options: FunctionTableOptions): HTMLElement {
  const { backendOmitted, clientCap, openCodePath, reportOmitted, rows, title } = options;
  const section = el('section', { class: 'card change-impact-entity-card' }, [
    el('h3', { text: title }),
  ]);
  const bounded = boundClientRows(rows, clientCap);
  if (bounded.rows.length === 0) {
    section.append(el('div', { class: 'empty', text: 'No stored functions.' }));
  } else {
    const table = el('table', { class: 'data-table' });
    table.append(el('caption', { text: title }));
    const header = el('tr');
    ['Function', 'Package', 'Location', 'Evidence', 'Code Paths'].forEach((label) =>
      header.append(el('th', { scope: 'col', text: label })),
    );
    table.append(el('thead', {}, [header]));
    const body = el('tbody');
    bounded.rows.forEach((value) => {
      const row = el('tr');
      row.append(
        el('th', { scope: 'row', text: value.qualifiedName }),
        el('td', { text: value.package ?? '—' }),
        el('td', { text: `${value.filePath}:${String(value.line)}` }),
        el('td', { text: value.reason }),
      );
      const navigation = el('td');
      if (value.navigation === 'available' && value.bodyHash && openCodePath) {
        const identity = { ...value, bodyHash: value.bodyHash };
        navigation.append(
          el('button', {
            type: 'button',
            class: 'fc-action',
            text: 'Open',
            'aria-label': `Open Code Paths for ${value.qualifiedName}`,
            onclick: () => openCodePath(identity),
          }),
        );
      } else {
        // Plain muted text: the reason is non-interactive and does not need a
        // disabled control or aria-disabled on a non-interactive span.
        navigation.append(
          el('span', {
            class: MUTED_CLASS,
            text: navigationReason(value, openCodePath !== undefined),
          }),
        );
      }
      row.append(navigation);
      body.append(row);
    });
    table.append(body);
    section.append(table);
  }
  if (backendOmitted > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(backendOmitted)} function row(s) omitted by the backend projection.`,
      }),
    );
  }
  if (reportOmitted > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(reportOmitted)} function row(s) omitted by the report budget.`,
      }),
    );
  }
  if (bounded.omitted > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(bounded.omitted)} function row(s) omitted by the defensive client limit.`,
      }),
    );
  }
  return section;
}

export function renderImpactEntities(
  container: HTMLElement,
  model: ChangeImpactViewModel,
  openCodePath?: OpenCodePath,
): void {
  if (!model.evidence) return;
  const evidence = model.evidence;
  container.append(
    functionTable({
      backendOmitted: evidence.backendOmitted.changedFunctions,
      clientCap: CHANGE_IMPACT_CLIENT_CAPS.changedFunctions,
      openCodePath,
      reportOmitted: model.reportOmitted.changedFunctions,
      rows: evidence.changedFunctions,
      title: 'Changed functions',
    }),
    functionTable({
      backendOmitted: evidence.backendOmitted.impactedFunctions,
      clientCap: CHANGE_IMPACT_CLIENT_CAPS.impactedFunctions,
      openCodePath,
      reportOmitted: model.reportOmitted.impactedFunctions,
      rows: evidence.impactedFunctions,
      title: 'Impacted functions',
    }),
  );
  const packages = el('section', { class: 'card change-impact-entity-card' }, [
    el('h3', { text: 'Impacted packages' }),
  ]);
  const boundedPackages = boundClientRows(
    evidence.impactedPackages,
    CHANGE_IMPACT_CLIENT_CAPS.impactedPackages,
  );
  if (boundedPackages.rows.length === 0)
    packages.append(el('div', { class: 'empty', text: 'No stored packages.' }));
  else {
    const list = el('ul', { class: 'change-impact-list' });
    boundedPackages.rows.forEach((item) =>
      list.append(
        el('li', {
          text: `${item.name}: ${String(item.functionCount)} function(s)`,
        }),
      ),
    );
    packages.append(list);
  }
  if (evidence.backendOmitted.impactedPackages > 0)
    packages.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(evidence.backendOmitted.impactedPackages)} package row(s) omitted by the backend projection.`,
      }),
    );
  if (model.reportOmitted.impactedPackages > 0)
    packages.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(model.reportOmitted.impactedPackages)} package row(s) omitted by the report budget.`,
      }),
    );
  if (boundedPackages.omitted > 0)
    packages.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(boundedPackages.omitted)} package row(s) omitted by the defensive client limit.`,
      }),
    );
  container.append(packages);
}
