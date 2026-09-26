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

/**
 * 第三方依赖拆包：react / react-dom / 路由 / zustand 合成一个 vendor-react 块，只随依赖升级才变。
 * 日常发版只改业务代码，这个块的文件名（内容哈希）不变，浏览器长缓存（max-age=1y, immutable）一直命中。
 * 分组宁粗勿细：总是一起用到的依赖放一块，别拆出一地碎文件白白多出请求。
 * tesseract.js 本来就是护照识别时才动态加载，保持 Rollup 自动拆出的独立块，不进首屏。
 */
const VENDOR_REACT_RE =
  /[\\/]node_modules[\\/](?:react|react-dom|scheduler|react-router|react-router-dom|@remix-run[\\/]router|zustand)[\\/]/;

function manualChunks(id: string): string | undefined {
  if (VENDOR_REACT_RE.test(id)) return 'vendor-react';
  // CommonJS 互操作帮助模块（react / react-dom 是 CJS 包，要靠它转 ESM）跟着 vendor 走：
  // 留给 Rollup 自动安排可能落进入口块，变成 vendor 反过来依赖入口，入口一变 vendor 哈希也跟着变。
  if (id.startsWith('\0') && id.includes('commonjsHelpers')) return 'vendor-react';
  return undefined;
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
    build: {
      rollupOptions: {
        output: { manualChunks },
      },
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
