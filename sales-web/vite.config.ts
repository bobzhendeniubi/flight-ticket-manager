import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  // 加载 .env / .env.development / .env.local 等，读取 VITE_* + 自定义前缀
  const env = loadEnv(mode, process.cwd(), '');
  const devProxyTarget = env.VITE_DEV_API_TARGET || 'http://localhost:4000';
  const devPort = Number(env.VITE_DEV_PORT || 5173);

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    build: {
      rollupOptions: {
        output: {
          // 把 React 运行时与路由拆到独立 vendor chunk —— 长缓存、与业务代码分离。
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
    },
    server: {
      port: devPort,
      proxy: {
        // 开发期把 /api 代理到后端，避免 CORS
        // 可用 VITE_DEV_API_TARGET 覆盖（比如指向 staging）
        '/api': {
          target: devProxyTarget,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    },
  };
});
