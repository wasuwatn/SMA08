import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

// Five entry points share one src/ tree:
//   index.html            → Mother (read / dashboards / admin)
//   pos.html              → POS satellite (installable, works offline)
//   expense.html          → Expense satellite
//   customer.html         → Customer rewards portal (opened inside LINE via LIFF)
//   expense-review.html   → LINE slip review portal (opened inside LINE via LIFF)
export default defineConfig({
  plugins: [
    react(),
    // Precaches the built app shell so POS/Expense open with no network.
    // API data is handled by our own localStorage cache + outbox, not the SW.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'KOTEA', short_name: 'KOTEA', display: 'standalone',
        background_color: '#f5f3ea', theme_color: '#5b6236'
      },
      // Multi-page app: disable the SPA navigation fallback so that requests
      // to /pos.html, /expense.html, /customer.html and /expense-review.html
      // are served from their own precached shells, not redirected to index.html.
      workbox: {
        navigateFallback: null
      }
    })
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        pos: resolve(__dirname, 'pos.html'),
        expense: resolve(__dirname, 'expense.html'),
        customer: resolve(__dirname, 'customer.html'),
        expenseReview: resolve(__dirname, 'expense-review.html')
      }
    }
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' }
  }
});
