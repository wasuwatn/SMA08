import { useState, useMemo } from 'react';
import { PAGE_SIZE } from './helpers.js';

// Client-side sorting + pagination for a list of rows.
export function useTable(rows, { initialSort = null, initialDir = 'asc', pageSize = PAGE_SIZE } = {}) {
  const [sort, setSort] = useState(initialSort);
  const [dir, setDir] = useState(initialDir);
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    const list = [...rows];
    if (sort) {
      list.sort((a, b) => {
        const va = a[sort], vb = b[sort];
        if (typeof va === 'number' && typeof vb === 'number') return dir === 'asc' ? va - vb : vb - va;
        return dir === 'asc'
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va));
      });
    }
    return list;
  }, [rows, sort, dir]);

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, total);

  const toggleSort = (field) => {
    if (sort === field) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(field); setDir('asc'); }
    setPage(1);
  };

  const sortIcon = (field) =>
    sort === field ? `fa-solid ${dir === 'asc' ? 'fa-arrow-up-long' : 'fa-arrow-down-long'}` : '';

  return { pageRows, page: safePage, setPage, total, pageSize, totalPages, from, to, toggleSort, sortIcon };
}
