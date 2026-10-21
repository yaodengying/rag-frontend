import axios from 'axios'
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'

import { useAuthStore } from '../store/auth'
import { notifyError } from '../utils/notify'
import { BASE_URL, TIMEOUT, TOKEN_HEADER, TOKEN_SCHEME } from './config'
import { ApiError, normalizeError, pickBackendMessage } from './error'
import { SUCCESS_CODES } from './types'
import type { ApiResponse } from './types'
import { LOGIN_PATH, UNAUTHORIZED_EVENT, handleUnauthorized } from './unauthorized'

// 配置（baseURL / 超时 / token 方案）统一放在 ./config，401 处理放在 ./unauthorized，
// 供 SSE 链路复用；这里做一次 re-export，保持既有引用路径不变。
export { BASE_URL, TIMEOUT, LOGIN_PATH, UNAUTHORIZED_EVENT }


/* ------------------------------------------------------------------ *
 * 实例
 * ------------------------------------------------------------------ */

export const http: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT,
  // 故意不写死 Content-Type：axios 会自动为普通对象用 application/json、
  // 为 FormData 用 multipart/form-data（含 boundary）。写死反而会破坏文件上传。
})

/* ------------------------------------------------------------------ *
 * 请求拦截器：注入 token
 * ------------------------------------------------------------------ */

http.interceptors.request.use((config) => {
  if (!config.skipAuth) {
    const token = useAuthStore.getState().token
    if (token) {
      config.headers.set(TOKEN_HEADER, `${TOKEN_SCHEME} ${token}`)
    }
  }
  return config
})

/* ------------------------------------------------------------------ *
 * 响应拦截器：解包 + 归一化错误 + 统一提示 + 401 处理
 * ------------------------------------------------------------------ */

http.interceptors.response.use(
  (response) => {
    try {
      // 运行时这里返回的是解包后的业务数据；类型上必须满足 axios 拦截器签名，
      // 因此在返回处做一次断言，真正的类型由下面的 get/post 等快捷方法保证。
      return unwrap(response) as AxiosResponse
    } catch (error) {
      // 业务错误是在这里主动抛的，不会走下面的 onRejected，需要自行收口
      return Promise.reject(reportFailure(error, response.config))
    }
  },
  (error: unknown) =>
    // HTTP 层错误：config 挂在 axios error 上，必须取出来传给 reportFailure，
    // 否则 skipAuthRedirect / skipErrorToast 这类请求开关在这里读不到而失效。
    Promise.reject(reportFailure(error, axios.isAxiosError(error) ? error.config : undefined)),
)

/**
 * 响应体是否符合后端统一包裹体结构。
 *
 * 判定条件刻意收窄为「有 code 且带有 data / message / msg 之一」，
 * 避免把业务数据里本来就有 code 字段的对象误判成包裹体。
 * 若后端结构不同，改这里即可；个别接口可用 `rawResponse: true` 绕过。
 */
function isEnvelope(body: unknown): body is ApiResponse {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false
  }
  const record = body as Record<string, unknown>
  const code = record.code
  const hasCode = typeof code === 'number' || typeof code === 'string'
  const looksLikeEnvelope = 'data' in record || 'message' in record || 'msg' in record
  return hasCode && looksLikeEnvelope
}

/** 解包：成功返回 data，业务失败抛 ApiError */
function unwrap(response: AxiosResponse): unknown {
  if (response.config.rawResponse) {
    return response
  }

  const body = response.data

  if (!isEnvelope(body)) {
    // 非包裹体（如直接返回数组、文件流）原样返回
    return body
  }

  if (SUCCESS_CODES.includes(body.code)) {
    return body.data
  }

  throw new ApiError({
    kind: 'business',
    status: response.status,
    code: body.code,
    message: pickBackendMessage(body) ?? `业务处理失败（code: ${body.code}）`,
    data: body,
  })
}

/** 统一收口：归一化 → 401 处理 → 全局提示 */
function reportFailure(error: unknown, config?: AxiosRequestConfig): ApiError {
  const apiError = normalizeError(error)

  // 登录 / 刷新 token 这类接口的 401 是业务结果，不该触发跳转（由 skipAuthRedirect 关闭）
  if (apiError.status === 401 && !config?.skipAuthRedirect) {
    handleUnauthorized()
  }

  // 主动取消不打扰用户；调用方显式关闭提示的也不提示
  if (apiError.kind !== 'canceled' && !config?.skipErrorToast) {
    notifyError(apiError.message)
  }

  return apiError
}

/* ------------------------------------------------------------------ *
 * 带类型的快捷方法
 *
 * 响应拦截器已经把包裹体解包成 data，因此这里的 Promise<T> 直接用业务类型标注，
 * 需要通过 `as unknown as` 抹掉 axios 自身的 AxiosResponse 返回类型。
 * ------------------------------------------------------------------ */

export function get<T = unknown>(
  url: string,
  params?: Record<string, unknown>,
  config?: AxiosRequestConfig,
): Promise<T> {
  return http.get(url, { params, ...config }) as unknown as Promise<T>
}

export function post<T = unknown>(
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  return http.post(url, data, config) as unknown as Promise<T>
}

export function put<T = unknown>(
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  return http.put(url, data, config) as unknown as Promise<T>
}

export function patch<T = unknown>(
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  return http.patch(url, data, config) as unknown as Promise<T>
}

export function del<T = unknown>(
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  return http.delete(url, { data, ...config }) as unknown as Promise<T>
}

export default http
