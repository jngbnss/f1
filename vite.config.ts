import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the app under /<repo>/ (set by the deploy workflow).
  base: process.env.BASE_PATH ?? '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
});
