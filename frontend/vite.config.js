import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tailwind v4 is configured through its Vite plugin and src/index.css (no tailwind.config.js needed).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin API calls in dev, so the httpOnly session cookie just works.
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
    },
  },
});
