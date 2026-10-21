import { EventStreamContentType, fetchEventSource } from '@microsoft/fetch-event-source'
import type { EventSourceMessage } from '@microsoft/fetch-event-source'

import { useAuthStore } from '../store/auth'
import { notifyError } from '../utils/notify'
import { TOKEN_HEADER, TOKEN_SCHEME, resolveUrl } from './config'
import { ApiError, normalizeError, pickBackendMessage } from './error'
import { handleUnauthorized } from './unauthorized'

/**
 * SSE 传输层封装（与业务协议无关）。
 *
 * 直接使用 `@microsoft/fetch-event-source` 有三个容易踩的坑，这里统一处理掉：
 *  1. 它不做 HTTP 状态校验，只校验 content-type，所以 401/500 会被当成正常流；
 *  2. 出错时默认会「静默重连」并重放整个请求，流式对话里会造成答案重复；
 *  3. 服务端不主动断连时连接会一直挂着，后端卡死不会有反馈。
 */

/** 默认空闲超时：超过这么久没收到任何消息就中断，避免连接假死 */
export const DEFAULT_IDLE_TIMEOUT = 60_000

/** 仅在「尚未收到任何内容」时才允许重连，避免重放导致答案重复 */
const DEFAULT_MAX_RETRIES = 0

/** 内部信号：用于从 onmessage 里主动结束流（例如收到 [DONE]） */
class StreamStopSignal {
  readonly reason: string

  constructor(reason: string) {
    this.reason = reason
  }
}

export interface SSEMessageControls {
  /** 主动结束流，不会触发错误提示 */
  stop: (reason?: string) => void
}

export interface SSEOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** 请求体，会被 JSON 序列化 */
  body?: unknown
  /** 外部取消信号（例如用户点「停止生成」） */
  signal?: AbortSignal
  /** 不注入 Authorization 头 */
  skipAuth?: boolean
  /** 出错时是否弹全局提示，默认 true */
  errorToast?: boolean
  /** 空闲超时（毫秒），0 表示不限制 */
  idleTimeout?: number
  /** 失败重连次数，仅在尚未收到内容时生效 */
  maxRetries?: number
  /** 重连间隔（毫秒） */
  retryInterval?: number
  fetch?: typeof fetch
}

export interface SSEHandlers {
  onOpen?: (response: Response) => void
  onMessage?: (message: EventSourceMessage, controls: SSEMessageControls) => void
  /** 流正常结束（含主动 stop）时触发 */
  onClose?: () => void
  /** 被外部 signal 取消时触发 */
  onAbort?: () => void
}

async function readErrorPayload(response: Response): Promise<unknown> {
  try {
    const text = await response.text()
    if (!text) {
      return undefined
    }
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } catch {
    return undefined
  }
}

function isRetryable(error: ApiError): boolean {
  return error.kind === 'network' || error.kind === 'timeout' || (error.status ?? 0) >= 500
}

/**
 * 发起一次 SSE 请求，按行回调事件。
 *
 * 正常结束 / 主动 stop 都会正常返回；出错以 ApiError 抛出；
 * 被外部 signal 取消时抛 ApiError(kind: 'canceled')，同时触发 onAbort。
 */
export async function streamSSE(
  url: string,
  options: SSEOptions = {},
  handlers: SSEHandlers = {},
): Promise<void> {
  const {
    method = 'POST',
    headers = {},
    body,
    signal: externalSignal,
    skipAuth = false,
    errorToast = true,
    idleTimeout = DEFAULT_IDLE_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryInterval = 1000,
    fetch: fetchImpl,
  } = options

  if (externalSignal?.aborted) {
    throw new ApiError({ kind: 'canceled', message: '请求已取消' })
  }

  // 内部控制器：用于空闲超时中断，同时联动外部 signal
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  externalSignal?.addEventListener('abort', onExternalAbort)

  let timedOut = false
  let receivedAny = false
  let attempt = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const clearIdle = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }
  const armIdle = () => {
    clearIdle()
    if (idleTimeout > 0) {
      idleTimer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, idleTimeout)
    }
  }

  const requestHeaders: Record<string, string> = { Accept: EventStreamContentType, ...headers }
  if (!skipAuth) {
    const token = useAuthStore.getState().token
    if (token) {
      requestHeaders[TOKEN_HEADER] = `${TOKEN_SCHEME} ${token}`
    }
  }
  if (body !== undefined && requestHeaders['Content-Type'] === undefined) {
    requestHeaders['Content-Type'] = 'application/json'
  }

  const fail = (error: ApiError): never => {
    if (error.kind !== 'canceled' && errorToast) {
      notifyError(error.message)
    }
    throw error
  }

  const controls: SSEMessageControls = {
    stop: (reason = 'done') => {
      throw new StreamStopSignal(reason)
    },
  }

  let streamError: ApiError | null = null

  try {
    armIdle()
    await fetchEventSource(resolveUrl(url), {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      // 保持连接在页面切到后台时不断开，长回答更容易完整收到
      openWhenHidden: true,
      fetch: fetchImpl ?? globalThis.fetch.bind(globalThis),
      onopen: async (response) => {
        if (!response.ok) {
          const payload = await readErrorPayload(response)
          if (response.status === 401) {
            handleUnauthorized()
          }
          throw new ApiError({
            kind: 'http',
            status: response.status,
            message:
              pickBackendMessage(payload) ?? `流式请求失败（HTTP ${response.status}）`,
            data: payload,
          })
        }

        const contentType = response.headers.get('content-type')
        if (!contentType || !contentType.includes(EventStreamContentType)) {
          throw new ApiError({
            kind: 'unknown',
            message: `响应不是 SSE 流（content-type: ${contentType ?? '未设置'}）`,
          })
        }

        armIdle()
        handlers.onOpen?.(response)
      },
      onmessage: (message) => {
        receivedAny = true
        armIdle()
        handlers.onMessage?.(message, controls)
      },
      onerror: (error: unknown) => {
        // 由 stop() 抛出的信号，直接透传给外层收尾
        if (error instanceof StreamStopSignal) {
          throw error
        }

        const apiError = normalizeError(error)
        const canRetry =
          !receivedAny &&
          attempt < maxRetries &&
          isRetryable(apiError) &&
          !controller.signal.aborted &&
          !externalSignal?.aborted

        if (canRetry) {
          attempt += 1
          return retryInterval
        }

        // 抛出去才能让库停止重连并 reject
        throw apiError
      },
    })
  } catch (error) {
    if (!(error instanceof StreamStopSignal)) {
      streamError = normalizeError(error)
    }
  } finally {
    clearIdle()
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }

  if (timedOut) {
    return fail(
      new ApiError({
        kind: 'timeout',
        message: `流式响应 ${idleTimeout}ms 内没有新数据，已中断`,
      }),
    )
  }

  if (externalSignal?.aborted) {
    handlers.onAbort?.()
    throw new ApiError({ kind: 'canceled', message: '已停止生成' })
  }

  if (streamError) {
    return fail(streamError)
  }

  handlers.onClose?.()
}
