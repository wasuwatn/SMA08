import React from 'react';
import { createRoot } from 'react-dom/client';
import { DataProvider } from './lib/data.jsx';
import SatelliteApp from './SatelliteApp.jsx';
import Expenses from './pages/Expenses.jsx';
import './lib/swReload.js';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DataProvider>
      <SatelliteApp title="KOTEA Expense" icon="fa-receipt" access="expenses" Page={Expenses} />
    </DataProvider>
  </React.StrictMode>
);
