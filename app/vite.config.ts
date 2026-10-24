import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolveApiBase } from './config/api-environment.mjs';

// Static SPA output only (no SSR, no meta framework). webDir feeds Capacitor.
export default defineConfig(({ mode }) => ({
  plugins: [preact()],
  define: {
    __API_BASE_URL__: JSON.stringify(
      resolveApiBase({
        mode,
        configured: process.env.VITE_API_BASE_URL,
      }),
    ),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
