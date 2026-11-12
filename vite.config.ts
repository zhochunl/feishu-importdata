import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // statfmt 的入口把 SPSS 读写器一并导出，那两个模块 import 了 node:zlib。
  // 标成 external 后整块 SPSS 代码会被摇掉，浏览器包里不会留下这个 import。
  build: {
    rollupOptions: { external: ['node:zlib'] },
  },
  server: {
    host: '0.0.0.0',
    port: 5070,
    cors: true,
  },
});
