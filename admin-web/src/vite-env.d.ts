/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API 基础 URL — 开发默认 /api；生产可设 https://api.citur.com */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** 构建期由 vite.config.ts 的 define 注入的构建号（git short sha；Docker 构建无 .git 时退化为时间戳）。 */
declare const __APP_BUILD_ID__: string;
