import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * 构建版本号：优先取 git short sha（本地 / CI 构建，仓库存在时能取到）；
 * Docker 多阶段构建的 builder 层没有 .git，取不到就退化用构建时间戳兜底——
 * 保证任何构建环境下都拿得到一个非空的 __APP_BUILD_ID__。
 */
function resolveBuildId(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return `ts-${Date.now()}`;
  }
}

/**
 * 发布一份 dist/version.json（{ buildId, builtAt }），供前端「新版本可用」轮询比对用。
 * 挂在 closeBundle：此时 outDir 已经写完，直接落一个静态文件进去，随 dist 一起进镜像。
 */
function buildVersionPlugin(buildId: string): Plugin {
  const builtAt = new Date().toISOString();
  let outDir = 'dist';
  let root = process.cwd();
  return {
    name: 'ftm-build-version',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
    },
    closeBundle() {
      const dir = path.isAbsolute(outDir) ? outDir : path.resolve(root, outDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ buildId, builtAt }));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const devProxyTarget = env.VITE_DEV_API_TARGET || 'http://localhost:4000';
  const devPort = Number(env.VITE_DEV_PORT || 5174);
  const buildId = resolveBuildId();

  return {
    define: {
      __APP_BUILD_ID__: JSON.stringify(buildId),
    },
    plugins: [react(), buildVersionPlugin(buildId)],
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    server: {
      port: devPort,
      proxy: {
        '/api': {
          target: devProxyTarget,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    },
  };
});
