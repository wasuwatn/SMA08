import React from 'react';
import { PAGE_SIZE } from '../lib/helpers.js';

export default function Pagination({ page, total, onPage, pageSize = PAGE_SIZE }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="pagination">
      <span className="info">Showing {from}-{to} of {total} records</span>
      <div className="buttons">
        <button className="btn btn-sm" disabled={page === 1} onClick={() => onPage(page - 1)}>
          <i className="fa-solid fa-chevron-left"></i> Prev
        </button>
        <span className="page-num">{page} / {totalPages}</span>
        <button className="btn btn-sm" disabled={page === totalPages} onClick={() => onPage(page + 1)}>
          Next <i className="fa-solid fa-chevron-right"></i>
        </button>
      </div>
    </div>
  );
}
