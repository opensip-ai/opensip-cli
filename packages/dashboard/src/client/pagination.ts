// @fitness-ignore-file toctou-race-condition -- wirePagination reads pageHandlers.get then pageHandlers.set on a module-level WeakMap of per-container handler slots; both operations are synchronous DOM-setup code (browser event handlers are serialized on the single JS thread), no async gap, safe in single-threaded JS.
/**
 * Pagination helpers — `paginateTable`, `paginateGroupedRows`, the page-button
 * renderer, and the delegated click wiring.
 *
 * Every data-table in the dashboard paginates at 10 rows/page (or
 * 10 groups/page when expander rows are present). The grouped variant
 * keeps a data row and its trailing `.expander-row` together so they
 * page as one unit.
 *
 * `renderPageButtons` is shared between both paginators and the checks catalog's
 * inline paginator; it is a PURE renderer — each button carries its target page
 * in `data-page-target` and no per-button click closure. Navigation is handled
 * by ONE delegated listener attached once to the pagination container via
 * {@link wirePagination}, which reads `data-page-target` off the clicked button
 * and invokes the caller's `goToPage`. This event-delegation pattern (vs.
 * per-button `onclick` closures that re-enter the render fn) keeps the render
 * path acyclic, attaches a single listener regardless of page count, and stays
 * correct as the buttons are re-rendered on each page change.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { el } from './el.js';

/** Page-navigation handler: jump to a zero-based page index. */
type GoToPage = (page: number) => void;

/**
 * Per-container slot holding the CURRENT navigation handler. The delegated
 * listener is attached once and always reads `current` from here, so a container
 * that is re-paginated with a different data source (e.g. the checks catalog
 * toggling between grouped and filtered rows) just swaps the handler — without
 * re-attaching a listener and without the render fn ever calling back into itself
 * (which is what created the static page-button → render cycle).
 */
const pageHandlers = new WeakMap<HTMLElement, { current: GoToPage }>();

/**
 * Wire a pagination container to a navigation handler. The first call attaches a
 * single delegated click listener; every call (re)sets the current handler. On a
 * click anywhere inside, the listener walks to the nearest enabled
 * `.pagination-btn[data-page-target]` and invokes the current handler with that
 * page index. Disabled buttons carry `data-page-disabled` and are ignored.
 */
export function wirePagination(paginationContainer: HTMLElement, goToPage: GoToPage): void {
  const existing = pageHandlers.get(paginationContainer);
  if (existing) {
    existing.current = goToPage;
    return;
  }
  const slot = { current: goToPage };
  pageHandlers.set(paginationContainer, slot);
  paginationContainer.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest<HTMLElement>('.pagination-btn[data-page-target]');
    if (!btn || btn.dataset.pageDisabled === 'yes') return;
    const page = Number(btn.dataset.pageTarget);
    if (Number.isNaN(page)) return;
    slot.current(page);
  });
}

/**
 * Render the page buttons into `container` (Prev / numbered / ellipsis / Next).
 * PURE: each navigable button carries its target page in `data-page-target`;
 * clicks are handled by the container-level listener set up via
 * {@link wirePagination}. The caller must wire its pagination container ONCE.
 */
export function renderPageButtons(
  container: HTMLElement,
  currentPage: number,
  totalPages: number,
): void {
  container.append(
    el('button', {
      class: 'pagination-btn' + (currentPage === 0 ? ' disabled' : ''),
      'data-page-target': '' + (currentPage - 1),
      'data-page-disabled': currentPage === 0 ? 'yes' : 'no',
      text: '← Prev',
    }),
  );

  const pages: number[] = [];
  for (let p = 0; p < totalPages; p++) {
    if (p < 2 || p >= totalPages - 2 || Math.abs(p - currentPage) <= 1) {
      pages.push(p);
    } else if (pages.length > 0 && pages.at(-1) !== -1) {
      pages.push(-1);
    }
  }

  pages.forEach((p) => {
    if (p === -1) {
      container.append(
        el('span', {
          style: 'color:var(--text-dim);padding:4px 4px;font-size:12px',
          text: '…',
        }),
      );
    } else {
      container.append(
        el('button', {
          class: 'pagination-btn' + (p === currentPage ? ' active' : ''),
          'data-page-target': '' + p,
          text: '' + (p + 1),
        }),
      );
    }
  });

  container.append(
    el('button', {
      class: 'pagination-btn' + (currentPage >= totalPages - 1 ? ' disabled' : ''),
      'data-page-target': '' + (currentPage + 1),
      'data-page-disabled': currentPage >= totalPages - 1 ? 'yes' : 'no',
      text: 'Next →',
    }),
  );
}

export function paginateTable(
  tbody: HTMLElement,
  paginationContainer: HTMLElement,
  pageSize: number,
): void {
  const rows = [...tbody.children] as HTMLElement[];
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));

  // `renderPage` takes the page as a parameter (no mutable closure re-entered by
  // a per-button click), and the delegated listener (wired once below) calls it.
  function renderPage(currentPage: number): void {
    const start = currentPage * pageSize;
    const end = start + pageSize;
    rows.forEach((row, i) => {
      row.style.display = i >= start && i < end ? '' : 'none';
    });

    while (paginationContainer.firstChild) paginationContainer.firstChild.remove();
    if (rows.length <= pageSize) return;

    const info = el('div', {
      class: 'pagination-info',
      text: 'Showing ' + (start + 1) + '-' + Math.min(end, rows.length) + ' of ' + rows.length,
    });
    paginationContainer.append(info);

    const btns = el('div', { class: 'pagination-btns' });
    renderPageButtons(btns, currentPage, totalPages);
    paginationContainer.append(btns);
  }

  // ONE delegated listener handles every page click for the lifetime of this
  // container — set up before the first render, never re-attached on re-render.
  wirePagination(paginationContainer, renderPage);
  renderPage(0);
}

export function paginateGroupedRows(
  tbody: HTMLElement,
  paginationContainer: HTMLElement,
  pageSize: number,
): void {
  const allRows = [...tbody.children] as HTMLElement[];
  const groups: HTMLElement[][] = [];
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    if (row.classList.contains('expander-row')) continue;
    const group = [row];
    if (i + 1 < allRows.length && allRows[i + 1].classList.contains('expander-row')) {
      group.push(allRows[i + 1]);
    }
    groups.push(group);
  }

  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));

  // `renderPage` takes the page as a parameter (no mutable closure re-entered by
  // a per-button click), and the delegated listener (wired once below) calls it.
  function renderPage(currentPage: number): void {
    const start = currentPage * pageSize;
    const end = start + pageSize;
    groups.forEach((group, i) => {
      const visible = i >= start && i < end;
      group.forEach((row) => {
        if (row.classList.contains('expander-row')) {
          row.dataset.paged = visible ? 'yes' : 'no';
          if (!visible) row.style.display = 'none';
        } else {
          row.style.display = visible ? '' : 'none';
        }
      });
    });

    while (paginationContainer.firstChild) paginationContainer.firstChild.remove();
    if (groups.length <= pageSize) return;

    const info = el('div', {
      class: 'pagination-info',
      text:
        'Showing ' +
        (start + 1) +
        '-' +
        Math.min(end, groups.length) +
        ' of ' +
        groups.length +
        ' checks',
    });
    paginationContainer.append(info);

    const btns = el('div', { class: 'pagination-btns' });
    renderPageButtons(btns, currentPage, totalPages);
    paginationContainer.append(btns);
  }

  // ONE delegated listener handles every page click for the lifetime of this
  // container — set up before the first render, never re-attached on re-render.
  wirePagination(paginationContainer, renderPage);
  renderPage(0);
}
