/**
 * Taro 构建配置。
 *
 * 环境：
 *   - dev:weapp → 开发编译 + watch（微信开发者工具里"导入"这个项目会看到 dist/）
 *   - build:weapp → 生产编译
 *
 * API base：
 *   - 开发：通过 `Taro.request` 访问 http://localhost:4000（需在微信开发者工具关"不校验合法域名"）
 *   - 生产：https://api.citur.com，需要在微信公众平台后台"服务器配置"白名单里加
 */
import path from 'path';

const config = {
  projectName: 'flight-ticket-manager-mp',
  date: '2026-4-22',
  designWidth: 750, // 微信小程序设计稿宽度（rpx 基准）
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    828: 1.81 / 2,
  },
  sourceRoot: 'src',
  outputRoot: 'dist',
  plugins: [],
  defineConstants: {
    // 可在代码里以 process.env.NODE_ENV 读取
  },
  copy: {
    patterns: [],
    options: {},
  },
  framework: 'react',
  compiler: 'webpack5',
  cache: { enable: false },
  alias: {
    '@': path.resolve(__dirname, '..', 'src'),
  },
  mini: {
    postcss: {
      pxtransform: { enable: true, config: {} },
      cssModules: { enable: false },
    },
  },
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
    postcss: {
      pxtransform: { enable: true, config: {} },
    },
  },
};

export default function (_merge: (cfg: typeof config) => typeof config) {
  if (process.env.NODE_ENV === 'development') {
    return _merge(require('./dev').default(config));
  }
  return _merge(require('./prod').default(config));
}
