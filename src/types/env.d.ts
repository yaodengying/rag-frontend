/// <reference types="vite/client" />

/** 项目自定义的环境变量类型（写在 .env.development / .env.production 中） */
interface ImportMetaEnv {
  /** 后端 API 基础地址。开发环境默认 /api，由 vite dev server 代理到真实后端 */
  readonly VITE_API_BASE_URL?: string
  /** 请求超时时间，单位毫秒 */
  readonly VITE_API_TIMEOUT?: string
  /** vite dev server 的代理目标，仅 vite.config.ts 使用 */
  readonly VITE_PROXY_TARGET?: string
}
