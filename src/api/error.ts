import axios from 'axios'

/** 错误分类，便于调用方按类型走不同分支 */
export type ApiErrorKind =
  /** 后端返回了非成功 code */
  | 'business'
  /** HTTP 状态码非 2xx */
  | 'http'
  /** 网络不可达 / 跨域失败 */
  | 'network'
  /** 超时 */
  | 'timeout'
  /** 调用方主动取消 */
  | 'canceled'
  /** 兜底 */
  | 'unknown'

export interface ApiErrorInit {
  kind: ApiErrorKind
  message: string
  status?: number
  code?: number | string
  data?: unknown
  cause?: unknown
}

/**
 * 统一错误对象。所有从请求层抛出的错误都会被规范化成它，
 * 调用方只需 `catch (e) { ... }` 即可拿到稳定的 kind / status / code / message。
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly code?: number | string
  readonly data?: unknown

  constructor(init: ApiErrorInit) {
    super(init.message)
    this.name = 'ApiError'
    this.kind = init.kind
    this.status = init.status
    this.code = init.code
    this.data = init.data
    if (init.cause !== undefined) {
      this.cause = init.cause
    }
  }

  /** 是否为鉴权失败 */
  get isUnauthorized(): boolean {
    return this.status === 401
  }

  /** 是否为超时或网络类错误，通常可提示用户重试 */
  get isRetryable(): boolean {
    return (
      this.kind === 'timeout' ||
      this.kind === 'network' ||
      (this.status !== undefined && this.status >= 500)
    )
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** 请求被主动取消（组件卸载、StrictMode 双挂载、用户停止等），通常应静默忽略 */
export function isCanceled(error: unknown): boolean {
  return isApiError(error) && error.kind === 'canceled'
}

/** HTTP 状态码 → 用户可读文案 */
const HTTP_STATUS_MESSAGE: Record<number, string> = {
  400: '请求参数有误',
  401: '登录状态已失效，请重新登录',
  403: '没有访问该资源的权限',
  404: '请求的资源不存在',
  405: '请求方法不被允许',
  406: '服务端无法处理该请求',
  408: '请求超时，请稍后重试',
  409: '数据冲突，请刷新后重试',
  413: '上传内容过大',
  415: '不支持的内容类型',
  422: '参数校验失败',
  429: '请求过于频繁，请稍后再试',
  500: '服务器内部错误',
  501: '服务未实现',
  502: '网关错误',
  503: '服务暂时不可用',
  504: '网关超时',
}

/**
 * 从后端响应体里尽量挖出可读的错误描述。
 * 兼容常见约定：message / msg / detail（FastAPI）/ error，
 * 以及 FastAPI 422 的 `detail: [{ msg }]` 形式。
 */
export function pickBackendMessage(data: unknown): string | undefined {
  if (typeof data === 'string') {
    return data.trim() ? data : undefined
  }
  if (!data || typeof data !== 'object') {
    return undefined
  }

  const record = data as Record<string, unknown>
  for (const key of ['message', 'msg', 'detail', 'error', 'errorMessage']) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return value
    }

    if (Array.isArray(value) && value.length > 0) {
      const first = value[0] as Record<string, unknown> | undefined
      if (first && typeof first.msg === 'string' && first.msg.trim()) {
        return first.msg
      }
    }
  }

  return undefined
}

/** 把任意异常（axios 错误、ApiError、普通 Error、字符串）统一成 ApiError */
export function normalizeError(error: unknown): ApiError {
  if (isApiError(error)) {
    return error
  }

  if (axios.isAxiosError(error)) {
    const { config, response, code } = error

    if (axios.isCancel(error) || code === 'ERR_CANCELED') {
      return new ApiError({ kind: 'canceled', message: '请求已取消', cause: error })
    }

    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      const timeout = config?.timeout
      return new ApiError({
        kind: 'timeout',
        message: timeout ? `请求超时（${timeout}ms），请稍后重试` : '请求超时，请稍后重试',
        cause: error,
      })
    }

    if (!response) {
      return new ApiError({
        kind: 'network',
        message: '网络异常，请检查网络连接后重试',
        cause: error,
      })
    }

    const status = response.status
    return new ApiError({
      kind: 'http',
      status,
      message:
        pickBackendMessage(response.data) ??
        HTTP_STATUS_MESSAGE[status] ??
        `请求失败（HTTP ${status}）`,
      data: response.data,
      cause: error,
    })
  }

  if (error instanceof Error) {
    // fetch / SSE 链路主动中断时抛 AbortError（浏览器里是 DOMException）
    if (error.name === 'AbortError' || error.name === 'CanceledError') {
      return new ApiError({ kind: 'canceled', message: '请求已取消', cause: error })
    }
    // fetch 的网络层失败统一抛 TypeError: Failed to fetch
    if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
      return new ApiError({
        kind: 'network',
        message: '网络异常，请检查网络连接后重试',
        cause: error,
      })
    }
    return new ApiError({ kind: 'unknown', message: error.message || '未知错误', cause: error })
  }

  return new ApiError({
    kind: 'unknown',
    message: typeof error === 'string' && error.trim() ? error : '未知错误',
    data: error,
  })
}

/** 一步拿到可直接展示给用户的错误文案 */
export function getErrorMessage(error: unknown): string {
  return normalizeError(error).message
}
