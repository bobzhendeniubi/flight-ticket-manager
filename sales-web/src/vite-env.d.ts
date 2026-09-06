/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API 基础 URL — 开发默认 /api；生产可设 https://api.citur.com */
  readonly VITE_API_BASE?: string;
  /**
   * ICP 备案号（F-7）：未配置时页脚不渲染 ICP 行，绝不显示"待补"占位文字。
   * 备案下来后由运营/部署方在生产环境变量里填入真实备案号。
   */
  readonly VITE_ICP_NUMBER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
