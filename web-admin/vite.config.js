import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/_admin/api': {
        target: 'http://127.0.0.1:15730',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../web'),
    // 保留旧 chunk：运行中面板的 SPA 引用着上一版文件名，清空会让已打开页面切路由时 401 空白
    // （2026-09-04 实锤）；assets 累积可定期手动清理。
    emptyOutDir: false,
  },
});
