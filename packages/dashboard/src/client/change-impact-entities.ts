import { el } from './el.js';

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

function functionTable(
  title: string,
  rows: readonly ChangeImpactFunctionModel[],
  openCodePath?: OpenCodePath,
): HTMLElement {
  const section = el('div', { class: 'card' }, [el('h3', { text: title })]);
  if (rows.length === 0) {
    section.append(el('div', { class: 'empty', text: 'No stored functions.' }));
    return section;
  }
  const table = el('table', { class: 'data-table' });
  const header = el('tr');
  ['Function', 'Package', 'Location', 'Evidence', 'Code Paths'].forEach((label) =>
    header.append(el('th', { text: label })),
  );
  table.append(el('thead', {}, [header]));
  const body = el('tbody');
  rows.forEach((value) => {
    const row = el('tr');
    row.append(
      el('td', { text: value.qualifiedName }),
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
          onclick: () => openCodePath(identity),
        }),
      );
    } else {
      navigation.append(
        el('span', {
          class: 'text-muted',
          'aria-disabled': 'true',
          text: navigationReason(value, openCodePath !== undefined),
        }),
      );
    }
    row.append(navigation);
    body.append(row);
  });
  table.append(body);
  section.append(table);
  return section;
}

export function renderImpactEntities(
  container: HTMLElement,
  model: ChangeImpactViewModel,
  openCodePath?: OpenCodePath,
): void {
  if (!model.evidence) return;
  container.append(
    functionTable('Changed functions', model.evidence.changedFunctions, openCodePath),
    functionTable('Impacted functions', model.evidence.impactedFunctions, openCodePath),
  );
  const packages = el('div', { class: 'card' }, [el('h3', { text: 'Impacted packages' })]);
  if (model.evidence.impactedPackages.length === 0)
    packages.append(el('div', { class: 'empty', text: 'No stored packages.' }));
  else {
    const list = el('ul', { class: 'change-impact-list' });
    model.evidence.impactedPackages.forEach((item) =>
      list.append(
        el('li', {
          text: `${item.name}: ${String(item.functionCount)} function(s)`,
        }),
      ),
    );
    packages.append(list);
  }
  container.append(packages);
}
