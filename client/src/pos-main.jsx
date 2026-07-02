import React from 'react';
import { createRoot } from 'react-dom/client';
import { DataProvider } from './lib/data.jsx';
import SatelliteApp from './SatelliteApp.jsx';
import POS from './pages/POS.jsx';
import './lib/swReload.js';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DataProvider skipHeavyTables>
      <SatelliteApp title="KOTEA POS" icon="fa-cash-register" access="pos" Page={POS} />
    </DataProvider>
  </React.StrictMode>
);
