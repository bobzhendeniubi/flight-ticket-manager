/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API 基础 URL — 开发默认 /api；生产可设 https://api.citur.com */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
