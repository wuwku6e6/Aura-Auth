import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
	plugins: [react()],
	base: './',
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		rollupOptions: {
			input: {
				main: resolve(__dirname, 'index.html'),
				inventory: resolve(__dirname, 'inventory.html'),
				cs2: resolve(__dirname, 'cs2.html'),
				offers: resolve(__dirname, 'offers.html'),
				settings: resolve(__dirname, 'settings.html')
			}
		}
	},
	server: {
		port: 5173,
		strictPort: true
	}
});