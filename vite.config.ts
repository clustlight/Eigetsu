import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: 5173,
    https: {},
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
      '/sfu': { target: 'http://localhost:3000', changeOrigin: true },
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          'mediasoup-client': ['mediasoup-client'],
        },
      },
    },
  },
});
