/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the popup into dist/; load that folder in chrome://extensions (Developer mode →
// Load unpacked). `pnpm dev` serves the popup as a normal page for quick UI work, with
// chrome.storage swapped for an in-memory stand-in.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    // Extension pages can't load inline scripts; keep everything in files.
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
  },
});
