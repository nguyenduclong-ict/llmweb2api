import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 3001,
    proxy: {
      '/v1': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
