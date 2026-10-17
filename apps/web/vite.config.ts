import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '0.0.0.0', port: 8080, strictPort: true },
  preview: { host: '0.0.0.0', port: 8080, strictPort: true },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 700 },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
