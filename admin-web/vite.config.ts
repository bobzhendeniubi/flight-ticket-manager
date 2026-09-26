import { defineConfig, loadEnv, type Plugin, type Rollup } from 'vite';
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

/**
 * 业务公共块 app-core：入口外壳（App / Layout）和懒加载页面都要用的业务模块
 * （api 客户端、登录态、通用弹窗 / 图标、日期工具、Vite 的预加载帮助函数等），从入口块里单独拿出来。
 *
 * 为什么必须拿出来：入口块里记着所有页面文件的带哈希文件名，任何一个页面改动入口块就换名；
 * 页面若从入口块 import 公共代码，入口一换名，所有页面的 import 路径跟着变 → 全部换哈希 →
 * 发一次版所有页面全员重下。拆出来后页面只依赖 app-core + vendor + 页面间共享块，
 * 只改某个页面时，重下的只有那个页面 + 很小的入口块。
 * （app-core 自身变了——比如 api.ts 改了——引用它的页面仍会连带换名，这是 ESM 带哈希文件名的固有代价。）
 *
 * 判定按模块依赖图自动算：入口静态可达 ∩ 任一懒加载模块静态可达。以后新增公共模块不用维护名单。
 */
function staticClosure(roots: Iterable<string>, getModuleInfo: Rollup.GetModuleInfo): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(getModuleInfo(id)?.importedIds ?? []));
  }
  return seen;
}

function collectAppCoreModules({ getModuleIds, getModuleInfo }: Rollup.ManualChunkMeta): Set<string> {
  const ids = [...getModuleIds()];
  const entries = ids.filter((id) => getModuleInfo(id)?.isEntry);
  const lazyRoots = ids.filter((id) => (getModuleInfo(id)?.dynamicImporters.length ?? 0) > 0);
  const shell = staticClosure(entries, getModuleInfo);
  const lazyReachable = staticClosure(lazyRoots, getModuleInfo);
  return new Set([...shell].filter((id) => lazyReachable.has(id)));
}

// 同一次产物生成里 Rollup 传进来的 meta 是同一个对象：按它缓存，整张依赖图只算一遍。
const appCoreCache = new WeakMap<Rollup.ManualChunkMeta, Set<string>>();

function manualChunks(id: string, meta: Rollup.ManualChunkMeta): string | undefined {
  if (VENDOR_REACT_RE.test(id)) return 'vendor-react';
  // CommonJS 互操作帮助模块（react / react-dom 是 CJS 包，要靠它转 ESM）跟着 vendor 走：
  // 留给 Rollup 自动安排可能落进入口块，变成 vendor 反过来依赖入口，入口一变 vendor 哈希也跟着变。
  if (id.startsWith('\0') && id.includes('commonjsHelpers')) return 'vendor-react';
  let appCore = appCoreCache.get(meta);
  if (!appCore) {
    appCore = collectAppCoreModules(meta);
    appCoreCache.set(meta, appCore);
  }
  return appCore.has(id) ? 'app-core' : undefined;
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
