import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Static SPA output only (no SSR, no meta framework). webDir feeds Capacitor.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
