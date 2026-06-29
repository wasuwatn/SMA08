import React from 'react';
import { useData } from '../lib/data.jsx';

const ICON = { success: 'fa-circle-check', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };

export default function Toasts() {
  const { toasts } = useData();
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`}>
          <i className={`fa-solid ${ICON[t.type] || ICON.info}`}></i>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
