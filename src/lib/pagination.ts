export type PageState<T> = {
  items: T[];
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  start: number;
  end: number;
};

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function paginate<T>(items: T[], rawPage: unknown, rawPageSize: unknown): PageState<T> {
  const pageSize = toPositiveInt(rawPageSize, 10);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, toPositiveInt(rawPage, 1));
  const startIndex = (page - 1) * pageSize;
  const pageItems = items.slice(startIndex, startIndex + pageSize);

  return {
    items: pageItems,
    page,
    pageCount,
    pageSize,
    total,
    start: total ? startIndex + 1 : 0,
    end: Math.min(total, startIndex + pageSize),
  };
}

export function paginationHtml<T>(state: PageState<T>, label = 'entries'): string {
  if (state.pageCount <= 1) {
    return state.total
      ? `<div class="v11-pagination v11-pagination-single"><span>${state.total} ${label}</span></div>`
      : '';
  }

  const pages = pageWindow(state.page, state.pageCount)
    .map((item) => {
      if (item === 'gap') return '<span class="v11-pagination-gap">…</span>';
      const active = item === state.page ? ' is-active' : '';
      return `<button type="button" class="v11-pagination-btn${active}" data-page="${item}" aria-label="page ${item}"${active ? ' aria-current="page"' : ''}>${item}</button>`;
    })
    .join('');

  return `<nav class="v11-pagination" aria-label="pagination">
    <button type="button" class="v11-pagination-btn" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>prev</button>
    <span class="v11-pagination-range">${state.start}-${state.end} / ${state.total} ${label}</span>
    <span class="v11-pagination-pages">${pages}</span>
    <button type="button" class="v11-pagination-btn" data-page="${state.page + 1}" ${state.page >= state.pageCount ? 'disabled' : ''}>next</button>
  </nav>`;
}

export function bindPagination(root: HTMLElement | Document, onPage: (page: number) => void): void {
  root.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      const page = Number.parseInt(button.dataset.page || '', 10);
      if (Number.isFinite(page)) onPage(page);
    });
  });
}

function pageWindow(page: number, pageCount: number): Array<number | 'gap'> {
  const pages = new Set<number>([1, pageCount]);
  for (let offset = -1; offset <= 1; offset += 1) {
    const candidate = page + offset;
    if (candidate >= 1 && candidate <= pageCount) pages.add(candidate);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const result: Array<number | 'gap'> = [];
  for (const item of sorted) {
    const previous = result[result.length - 1];
    if (typeof previous === 'number' && item - previous > 1) result.push('gap');
    result.push(item);
  }
  return result;
}
