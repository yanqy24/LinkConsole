import { defineConfig } from 'vite';

// Tauri 需要固定端口与 es2015 目标（WebView2 支持 es2022，这里保持保守）
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'chrome110',
    minify: 'esbuild',
    sourcemap: false,
    chunkSizeWarningLimit: 1500
  }
});
