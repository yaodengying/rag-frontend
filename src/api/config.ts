/**
 * 请求层共享配置。axios 实例（http.ts）与 SSE 客户端（sse.ts）都从这里取值，
 * 避免两套请求链路各写一份 baseURL / token 方案。
 */

/** token 所在的请求头与拼接方案 */
export const TOKEN_HEADER = 'Authorization'
export const TOKEN_SCHEME = 'Bearer'

/**
 * 后端（rag-backend）把全部业务路由挂在 `/api/v1` 下，所以默认基址就是它。
 * 改后端版本前缀时，这里与 .env 的 VITE_API_BASE_URL 要一起改。
 */
const DEFAULT_BASE_URL = '/api/v1'
const DEFAULT_TIMEOUT = 15_000

function readEnv(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : fallback
}

function readTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** 普通请求的 baseURL */
export const BASE_URL = readEnv(import.meta.env.VITE_API_BASE_URL, DEFAULT_BASE_URL)

/** 普通请求的超时时间（流式请求不用这个，见 sse.ts 的空闲超时） */
export const TIMEOUT = readTimeout(import.meta.env.VITE_API_TIMEOUT, DEFAULT_TIMEOUT)

/** 把相对路径拼成完整请求地址；已是绝对地址则原样返回 */
export function resolveUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path
  }
  const base = BASE_URL.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}
