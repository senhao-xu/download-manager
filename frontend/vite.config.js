import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// In dev, proxy /api to the backend (PORT 8001). In production the backend
// serves this built bundle via StaticFiles (same origin).
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://127.0.0.1:8001',
        },
    },
});
