import React from 'react';
import { createRoot } from 'react-dom/client';
import ExpenseReview from './pages/ExpenseReview.jsx';
import ChatSlipReview from './pages/ChatSlipReview.jsx';
import { readFlow } from './lib/liff.js';
import './styles.css';
import './expense-review.css';

// Standalone LIFF page(s) for LINE expense intake. Deliberately NOT wrapped
// in DataProvider or any staff/customer auth — access to a given slip is
// gated purely by the confirm_token in the URL. Two flows share this one
// entry/deploy (same LIFF app, same Vercel project):
//   - default: the Make.com OCR + single-slip form (INTEGRATION_PLAN.md Phase 1)
//   - ?flow=chat: the in-chat bot's multi-item checklist (server/lineExpense.js),
//     opened from the Flex card's "แก้ไขรายการ" button
// readFlow() (not a bare URLSearchParams check) because LIFF's redirect can
// wrap the whole query string inside ?liff.state=... instead of passing it
// directly — missing that would silently load the wrong page/data model.
const isChatFlow = readFlow() === 'chat';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isChatFlow ? <ChatSlipReview /> : <ExpenseReview />}
  </React.StrictMode>
);
