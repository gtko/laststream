import { defineConfig } from 'vite';

// Relais same-origin vers le serveur de streaming Stremio : il n'envoie les en-têtes CORS qu'à strem.io / stremio.com,
// le navigateur refuserait sinon sondage, playlists HLS (audio, sous-titres) et sous-titres depuis cette origine.
const streamingServer = {
  '/_ss': { target: 'http://127.0.0.1:11470', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/_ss/, '') },
};

export default defineConfig({
  server: { host: '0.0.0.0', port: 8080, strictPort: true, proxy: streamingServer },
  preview: { host: '0.0.0.0', port: 8080, strictPort: true, proxy: streamingServer },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 700 },
  test: {
    environment: 'jsdom',
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ['tests/**/*.test.ts'],
  },
});
