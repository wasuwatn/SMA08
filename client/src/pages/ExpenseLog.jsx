import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { money } from '../lib/helpers.js';
import { useTable } from '../lib/useTable.js';
import Pagination from '../components/Pagination.jsx';

export default function ExpenseLog() {
  const { data, remove, pushToast } = useData();
  const [search, setSearch] = useState('');

  const expenses = useMemo(() => [...data.expenses].sort((a, b) => b.id - a.id), [data.expenses]);
  const filteredExpenses = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return expenses;
    return expenses.filter(r => [r.description, r.category, r.buyer, r.note, r.date].some(v => String(v || '').toLowerCase().includes(q)));
  }, [expenses, search]);
  const { pageRows, page, setPage, total, pageSize } = useTable(filteredExpenses, { pageSize: 15 });

  const del = async (id) => { if (confirm('Delete this expense record?')) { await remove('expenses', id); pushToast('Expense deleted.', 'success'); } };

  return (
    <div className="card">
      <div className="card-header"><h3>Expense Log</h3>
        <div className="flex-between" style={{ gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <input className="form-control" style={{ maxWidth: 160 }} placeholder="Search expenses..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th><th>Qty</th><th>Buyer</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {pageRows.length ? pageRows.map(r => (
              <tr key={r.id}>
                <td>{r.date}</td><td><strong>{r.description}</strong></td>
                <td><span className="badge local">{r.category}</span></td>
                <td><strong>{money(r.amount)}</strong></td>
                <td>{r.qty} {r.unit || 'pcs'}</td>
                <td>{r.buyer}</td>
                <td><span className="helper-text">{r.note || '-'}</span></td>
                <td><button className="btn btn-sm btn-danger" onClick={() => del(r.id)}><i className="fa-solid fa-trash-can"></i></button></td>
              </tr>
            )) : <tr className="empty-row"><td colSpan={8}>No expenses recorded.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={total} onPage={setPage} pageSize={pageSize} />
    </div>
  );
}
