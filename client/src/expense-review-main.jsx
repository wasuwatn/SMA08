import React from 'react';
import { createRoot } from 'react-dom/client';
import ExpenseReview from './pages/ExpenseReview.jsx';
import './styles.css';
import './expense-review.css';

// Standalone LIFF page for the LINE x Make.com receipt-OCR expense intake
// (see INTEGRATION_PLAN.md Phase 1). Deliberately NOT wrapped in
// DataProvider or any staff/customer auth — access to a given slip is
// gated purely by the confirm_token in the URL (see lib/lineSlipApi.js).
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ExpenseReview />
  </React.StrictMode>
);
