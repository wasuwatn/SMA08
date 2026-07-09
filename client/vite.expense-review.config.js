import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Standalone build: expense-review.html only, for deploying the LINE LIFF
// expense-slip review page to its own domain (Vercel) — same reasoning as
// vite.customer.config.js (LIFF "Endpoint URL" needs a stable public HTTPS
// domain, independent of when/where staff run the Mother/POS/Expense apps
// built by vite.config.js). Build with `npm run build:expense-review`.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-expense-review',
    rollupOptions: {
      input: {
        'expense-review': resolve(__dirname, 'expense-review.html')
      }
    }
  }
});
