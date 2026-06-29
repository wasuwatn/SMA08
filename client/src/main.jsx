import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { DataProvider } from './lib/data.jsx';
import './lib/swReload.js';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DataProvider>
      <App />
    </DataProvider>
  </React.StrictMode>
);
