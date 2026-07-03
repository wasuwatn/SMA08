import React from 'react';
import { createRoot } from 'react-dom/client';
import CustomerPortal from './pages/CustomerPortal.jsx';
import './styles.css';
import './customer.css';

// Standalone customer-facing app (opened inside LINE via LIFF). Deliberately
// NOT wrapped in DataProvider — it must never load staff tables, only the
// customer's own loyalty data via /api/customer/*.
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <CustomerPortal />
  </React.StrictMode>
);
