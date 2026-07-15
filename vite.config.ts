import { defineConfig } from 'vite';

// mGBA WASM core uses pthreads (SharedArrayBuffer) → cross-origin isolation required.
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    headers: COI_HEADERS,
  },
  preview: {
    host: '127.0.0.1',
    port: 5181,
    strictPort: true,
    headers: COI_HEADERS,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
