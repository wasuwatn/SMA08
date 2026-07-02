import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

// Standalone build: customer.html only, for deploying the LINE LIFF rewards
// portal to its own domain (Vercel), independent of when/where staff run the
// Mother/POS/Expense apps built by vite.config.js. Build with
// `npm run build:customer` (see package.json in this dir and the repo root).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'KOTEA Rewards', short_name: 'KOTEA', display: 'standalone',
        background_color: '#f5f3ea', theme_color: '#5b6236',
        start_url: '/', scope: '/'
      },
      workbox: {
        navigateFallback: null
      }
    })
  ],
  build: {
    outDir: 'dist-customer',
    rollupOptions: {
      input: {
        customer: resolve(__dirname, 'customer.html')
      }
    }
  }
});
