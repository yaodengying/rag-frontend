import type { EventSourceMessage } from '@microsoft/fetch-event-source'

import { ApiError, normalizeError, pickBackendMessage } from '../error'
import { get } from '../http'
import { streamSSE } from '../sse'
import { SUCCESS_CODES } from '../types'

/**
 * RAG 流式对话接口。
 *
 * 后端的流式协议各家不同，这里的默认解码器兼容三种常见写法，
 * 如果你的后端不一样，通过 `options.decode` 传自己的解码器即可，不必改本文件。
 */

/** 对话流式接口地址（相对 BASE_URL） */
export const CHAT_ENDPOINT = '/chat/stream'

/** 问答能力与默认值接口地址（相对 BASE_URL） */
export const CHAT_OPTIONS_ENDPOINT = '/chat/options'

export interface ChatReference {
  id?: string
  /** 来源文件名 */
  title?: string
  /**
   * 溯源页码，形如「第3页」/「第3-5页」。
   *
   * 后端 `sources` / `citations` 都带这个字段（同一份 `Chunk.page_label`），
   * 历史消息（/conversations）也一并持久化了它——换时间、换设备翻历史
   * 都要能核对页码，所以它是引用契约的一部分，不是可选彩蛋。
   * 只有加载阶段就没拿到页码的格式才会缺席（此时前端整块不渲染）。
   */
  page?: string
  /** 片段正文预览 */
  content?: string
  /** 展示用相关度（优先余弦相似度 0~1） */
  score?: number
  [key: string]: unknown
}

/** 多轮历史中的一轮，对齐后端 `{role, content}` */
export interface ChatHistoryTurn {
  role: string
  content: string
}

/**
 * 问答请求。字段对齐后端 `schemas.ChatRequest`：
 *     { kb_id, question, conversation_id?, history?, top_k, rerank_k, enable_retry }
 *
 * 这里用驼峰，发送时由 `streamChat` 转成后端要的下划线命名。
 *
 * 会话历史的真相源在**服务端 Redis**：
 *  - `conversationId` 传了 → 服务端从 Redis 读历史送进提示词，回答连同
 *    溯源（文档名+页码）自动落库，请求体里的 `history` 会被忽略（不发）；
 *  - 不传 → 服务端生成新会话 ID（首问也落库），从 `done` 事件的
 *    `conversationId` 拿回来，下一轮带上它即可续聊。
 */
export interface ChatRequest {
  /** 目标知识库 ID，后端必填（缺失会被 422 拒绝） */
  kbId: string
  question: string
  /** 会话 ID（服务端 Redis 的多轮历史）。不传 = 开新会话 */
  conversationId?: string
  /** 多轮历史；仅「不带 conversationId」时发送（旧后端兼容路径） */
  history?: ChatHistoryTurn[]
  /** 向量召回条数（1~50）；不传则用服务端配置 */
  topK?: number
  /** 重排后保留条数（1~20）；不传则用服务端配置 */
  rerankK?: number
  /**
   * 仅流式接口生效：首轮检索没找到时，是否允许「改写查询再检索一次」。
   *
   * **三态**，三个值含义不同，别把它当成普通布尔：
   *  - `true` / `false`：这是**用户的选择**，服务端照办（会压过服务端默认值）；
   *  - `undefined`（不传该字段）：调用方没表态 → 落到服务端默认值
   *    （`GET /chat/options` 的 `streamRetryDefault`）。
   *
   * 之所以要区分「用户关掉」与「用户没表态」，是因为服务端默认值可能是 `true`：
   * 写成「假值就走默认」会让用户关掉开关后依然在重试，而界面上开关是关的。
   */
  enableRetry?: boolean | null
}

/**
 * 服务端问答能力与默认值（`GET /chat/options`）。
 *
 * 前端要渲染「是否允许改写重试」的开关，就必须知道服务端当前的默认值才能
 * 给出正确的初始状态。默认值**只由服务端持有**，前端来读——自己抄一份常量
 * 的后果是两个地方各说各话（界面上开着、后端其实没重试），而且没有任何报错。
 */
export interface ChatOptions {
  /** 请求未表态（不传 enableRetry / 传 null）时，服务端采用的默认值 */
  streamRetryDefault: boolean
  /** 单次请求最多做几次改写重试（对应服务端 MAX_RETRY） */
  streamRetryMaxAttempts: number
  /** 流式事件名清单（retry/sources/delta/done/error），仅供排查用 */
  streamEvents: string[]
  /** 非流式 `/chat` 是否**恒**重试一次（与 enableRetry 无关） */
  nonStreamAlwaysRetries: boolean
}

function pickBool(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') {
      return value
    }
  }
  return undefined
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

/** 后端返回 `{stream_retry_default, stream_retry_max_attempts, ...}`，这里归一成驼峰 */
export function normalizeChatOptions(raw: unknown): ChatOptions {
  const record = (raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>
  const events = record.stream_events ?? record.streamEvents
  return {
    // 读不到时按「关」处理：默认值宁可比真实值保守，也不要凭空多花 2~4 秒
    streamRetryDefault: pickBool(record, 'stream_retry_default', 'streamRetryDefault') ?? false,
    streamRetryMaxAttempts:
      pickNumber(record, 'stream_retry_max_attempts', 'streamRetryMaxAttempts') ?? 1,
    streamEvents: Array.isArray(events) ? events.filter((item) => typeof item === 'string') : [],
    nonStreamAlwaysRetries:
      pickBool(record, 'non_stream_always_retries', 'nonStreamAlwaysRetries') ?? true,
  }
}

/**
 * 读取服务端的问答能力与默认值。
 *
 * 失败时不弹全局提示（由调用方决定怎么降级）：这个接口只影响开关的初始状态，
 * 拿不到时「不发 enable_retry、跟随服务端默认」仍然是正确行为。
 */
export async function fetchChatOptions(
  options: { signal?: AbortSignal; skipErrorToast?: boolean } = {},
): Promise<ChatOptions> {
  const raw = await get<unknown>(CHAT_OPTIONS_ENDPOINT, undefined, {
    signal: options.signal,
    // 默认关掉全局提示：开关初始化失败不该盖住页面上的其它提示
    skipErrorToast: options.skipErrorToast ?? true,
  })
  return normalizeChatOptions(raw)
}

/**
 * `done` 事件回填的收尾事实。
 *
 * 后端把它放在同一个事件里（成功与拒答两条路径字段集完全相同），
 * 前端因此不需要「靠有没有某个键」分两个解析分支。
 */
export interface ChatDoneInfo {
  /** 完整回答（与逐段累加的 content 等价） */
  answer: string
  /** 是否因资料不足而拒答（此时 answer 是固定话术，没调过大模型） */
  refused: boolean
  /**
   * 检索阶段是否**真的**用改写后的查询重新检索过。
   * 注意它不等于「调过改写」：改写无产出时会放弃重试，
   * 此时 attempts=1 而 retried=false。
   */
  retried: boolean
  /** 改写尝试次数（含「改写了但无产出」那一次） */
  attempts: number
  /**
   * 服务端认为这一问**还能再试一次**（首轮没找到，且重试额度还没用满）。
   * 前端据此"先出结果、真没找到才问用户"，而不是让用户事先盲签一个开关。
   */
  canRetry: boolean
  /** 本轮实际用于检索的查询（发生过改写时与用户问题不同） */
  query: string
  /**
   * 本轮归属的会话 ID（服务端 Redis）。首问时由服务端生成并在这里回传，
   * 下一轮带上它即可续聊；服务端未配置会话存储时为 undefined。
   */
  conversationId?: string
}

/** 解码后的对话事件 */
export type ChatStreamEvent =
  /** 服务端开始改写查询并重新检索（位置在 sources 之前，用来填住那段静默） */
  | { type: 'retry'; attempt: number; maxAttempts: number; reason?: string }
  | { type: 'delta'; content: string }
  | { type: 'references'; references: ChatReference[] }
  | { type: 'meta'; conversationId?: string }
  /** 结束；服务端给了收尾事实时带 info（老后端只有裸 done） */
  | { type: 'done'; info?: ChatDoneInfo }
  | { type: 'error'; message: string }

export interface ChatStreamResult {
  /** 本轮完整回答 */
  content: string
  references: ChatReference[]
  conversationId?: string
  /** 是否因外部取消而中断（中断时 content 为已生成的部分） */
  aborted: boolean
  /** 收尾事实（服务端未提供时为 undefined） */
  done?: ChatDoneInfo
}

export interface ChatStreamHandlers {
  onOpen?: () => void
  /** 每收到一段增量文本 */
  onDelta?: (chunk: string, full: string) => void
  /** 每个解码后的事件（含 references / meta / retry） */
  onEvent?: (event: ChatStreamEvent) => void
  /** 服务端开始改写查询重试（可用来把"正在重新检索"的提示打出来） */
  onRetry?: (event: Extract<ChatStreamEvent, { type: 'retry' }>) => void
  onDone?: (result: ChatStreamResult) => void
  /** 出错（不含主动取消） */
  onError?: (error: ApiError) => void
  /** 被主动取消 */
  onAbort?: () => void
}

export interface ChatStreamOptions {
  signal?: AbortSignal
  /** 覆盖默认的事件解码器 */
  decode?: (message: EventSourceMessage) => ChatStreamEvent | ChatStreamEvent[] | null
  idleTimeout?: number
  skipAuth?: boolean
  errorToast?: boolean
  endpoint?: string
}

const REFERENCE_KEYS = ['sources', 'references', 'docs', 'documents', 'citations'] as const

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 归一化一条引用。
 *
 * 后端 `schemas.SourceOut` 是
 *     `{ doc_id, filename, page, chunk_index, text, vector_score, rerank_score }`
 * 而页面用的是 `{ id, title, content, score }`，这里做一次映射，
 * 同时用 `...record` 保留原始字段（页码、各路分数都还能取到）。
 */
export function normalizeReference(raw: unknown): ChatReference {
  if (typeof raw === 'string') {
    return { content: raw }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { content: String(raw) }
  }
  const record = raw as Record<string, unknown>
  const str = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  const num = (key: string): number | undefined => {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  return {
    ...record,
    id: str('chunk_id') ?? str('doc_id') ?? str('id'),
    title: str('filename') ?? str('title') ?? str('doc_name') ?? str('source'),
    content: str('text') ?? str('content') ?? str('snippet'),
    // 展示用分数优先取余弦相似度（0~1，百分比与进度条都能直接用）；
    // 它缺席（这一路没召回）时退到重排原始 logits
    score: num('vector_score') ?? num('rerank_score') ?? num('score'),
  }
}

function pickReferences(record: Record<string, unknown>): ChatReference[] | undefined {
  for (const key of REFERENCE_KEYS) {
    const value = record[key]
    if (!Array.isArray(value) || value.length === 0) {
      continue
    }
    return value.map(normalizeReference)
  }
  return undefined
}

/** 收成普通对象（数组与 null 不算） */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

/**
 * 构造 `done` 事件。
 *
 * 后端事件体是
 *     `{type, answer, refused, citations, retried, attempts, can_retry, query}`
 * 缺字段时一律落保守默认值（尤其 `canRetry` 取 false）：宁可少弹一次
 * 「再找一次」，也不要给用户一个点了没用的按钮。
 */
function buildDoneEvent(payload: unknown): ChatStreamEvent {
  const record = asRecord(payload)
  if (!record) {
    return { type: 'done' }
  }
  // 个别部署会把业务体再包一层 data
  const inner = asRecord(record.data) ?? record
  return {
    type: 'done',
    info: {
      answer: typeof inner.answer === 'string' ? inner.answer : '',
      refused: inner.refused === true,
      retried: inner.retried === true,
      attempts: pickNumber(inner, 'attempts') ?? 0,
      canRetry: inner.can_retry === true,
      query: typeof inner.query === 'string' ? inner.query : '',
      ...(typeof inner.conversation_id === 'string' && inner.conversation_id
        ? { conversationId: inner.conversation_id }
        : {}),
    },
  }
}

/** 构造 `retry` 事件（服务端开始改写查询并重新检索） */
function buildRetryEvent(payload: unknown): ChatStreamEvent {
  const record = asRecord(payload) ?? {}
  const reason = typeof record.reason === 'string' ? record.reason : undefined
  return {
    type: 'retry',
    attempt: pickNumber(record, 'attempt') ?? 1,
    maxAttempts: pickNumber(record, 'max_attempts', 'maxAttempts') ?? 1,
    ...(reason ? { reason } : {}),
  }
}

/** 从各种常见字段里取增量文本 */
function pickText(record: Record<string, unknown>): string | undefined {
  for (const key of ['content', 'delta', 'text', 'answer', 'token']) {
    const value = record[key]
    if (typeof value === 'string') {
      return value
    }
  }

  // OpenAI 兼容格式：choices[0].delta.content
  const choices = record.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown> | undefined
    if (first) {
      const delta = first.delta as Record<string, unknown> | undefined
      if (delta && typeof delta.content === 'string') {
        return delta.content
      }
      if (typeof first.text === 'string') {
        return first.text
      }
    }
  }

  return undefined
}

function decodePayload(payload: unknown): ChatStreamEvent[] {
  if (typeof payload === 'string') {
    return payload ? [{ type: 'delta', content: payload }] : []
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return []
  }

  const record = payload as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : undefined

  if (type === 'done' || type === 'end' || type === 'finish') {
    return [buildDoneEvent(record)]
  }
  if (type === 'retry') {
    return [buildRetryEvent(record)]
  }
  if (type === 'error') {
    return [{ type: 'error', message: pickBackendMessage(record) ?? '流式返回错误' }]
  }

  const events: ChatStreamEvent[] = []
  const text = pickText(record)
  if (text) {
    events.push({ type: 'delta', content: text })
  }

  const references = pickReferences(record)
  if (references) {
    events.push({ type: 'references', references })
  }

  if (events.length === 0) {
    const conversationId =
      typeof record.conversationId === 'string' ? record.conversationId : undefined
    if (conversationId) {
      events.push({ type: 'meta', conversationId })
    }
  }

  return events
}

/**
 * 默认解码器。按以下顺序识别：
 *  1. `data: [DONE]` 或 `event: end` → 结束（无收尾事实）
 *  2. `event: done` → 结束，并解析出收尾事实（refused / retried / can_retry / query）
 *  3. `event: retry` → 服务端开始改写查询重试
 *  4. `event: error` → 错误
 *  5. JSON 业务包裹体 `{code, message, data}` → code 非成功报错，成功则解 data
 *  6. JSON 对象里的 `content` / `delta` / `text` / `answer` / `token`，或 OpenAI 的 `choices[0].delta.content` → 增量
 *  7. `references` / `sources` / `docs` / `citations` → 引用
 *  8. 其它非 JSON 文本 → 当作纯文本增量
 *
 * 为什么 `done` 要单独认一遍而不是只认 `type`：`done` 是唯一携带收尾事实的
 * 事件，而它同时出现在 `event: done` 与 data 里的 `"type":"done"` 两处。
 */
export function decodeChatChunk(message: EventSourceMessage): ChatStreamEvent[] {
  const raw = message.data
  const eventName = (message.event ?? '').toLowerCase()

  if (raw === '[DONE]' || eventName === 'end') {
    return [{ type: 'done' }]
  }
  if (eventName === 'done') {
    return [buildDoneEvent(safeJsonParse(raw))]
  }
  if (eventName === 'retry') {
    return [buildRetryEvent(safeJsonParse(raw))]
  }
  if (!raw) {
    return []
  }
  if (eventName === 'error') {
    // 后端的 error 事件体是 {"type":"error","detail":"...","code":"..."}，
    // 直接把整段 JSON 当文案会把大括号和转义符甩到用户脸上
    return [{ type: 'error', message: pickBackendMessage(safeJsonParse(raw)) ?? raw }]
  }

  const parsed = safeJsonParse(raw)
  if (parsed === undefined) {
    return [{ type: 'delta', content: raw }]
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    const code = record.code
    if (typeof code === 'number' || typeof code === 'string') {
      if (!SUCCESS_CODES.includes(code)) {
        return [
          { type: 'error', message: pickBackendMessage(record) ?? `服务返回错误（code: ${code}）` },
        ]
      }
      return record.data === undefined || record.data === null ? [] : decodePayload(record.data)
    }
  }

  return decodePayload(parsed)
}

function toArray(
  value: ChatStreamEvent | ChatStreamEvent[] | null | undefined,
): ChatStreamEvent[] {
  if (!value) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

/**
 * 发起一次流式对话。
 *
 * - 正常结束 → resolve，返回完整回答
 * - 被 `options.signal` 取消 → resolve，`aborted: true`，保留已生成的部分
 * - 其它错误 → reject（ApiError），同时触发 `onError`
 */
export async function streamChat(
  request: ChatRequest,
  handlers: ChatStreamHandlers = {},
  options: ChatStreamOptions = {},
): Promise<ChatStreamResult> {
  if (!request.kbId) {
    // 后端 kb_id 是必填字段（缺失返回 422），提前挡掉能给出更明确的提示
    throw new ApiError({ kind: 'business', message: '请先选择要问答的知识库' })
  }

  const decode = options.decode ?? decodeChatChunk

  let content = ''
  let references: ChatReference[] = []
  let conversationId = request.conversationId
  let aborted = false
  let doneInfo: ChatDoneInfo | undefined

  const result = (): ChatStreamResult => ({
    content,
    references,
    conversationId,
    aborted,
    ...(doneInfo ? { done: doneInfo } : {}),
  })

  const emit = (event: ChatStreamEvent): void => {
    switch (event.type) {
      case 'delta':
        content += event.content
        handlers.onDelta?.(event.content, content)
        break
      case 'references':
        references = event.references
        break
      case 'meta':
        if (event.conversationId) {
          conversationId = event.conversationId
        }
        break
      case 'retry':
        handlers.onRetry?.(event)
        break
      case 'error':
        // 抛出去交给统一错误链路处理
        throw new ApiError({ kind: 'business', message: event.message })
      case 'done':
        // 收尾事实留到最后一起给（onDone），这里不回调，避免"事件 + 结果"两处打架
        if (event.info) {
          doneInfo = event.info
          // 首问的会话 ID 由服务端在 done 里回传——比 meta 事件更可靠
          //（成功与拒答两条路径都带，字段集唯一）
          if (event.info.conversationId) {
            conversationId = event.info.conversationId
          }
        }
        break
    }
  }

  try {
    await streamSSE(
      options.endpoint ?? CHAT_ENDPOINT,
      {
        method: 'POST',
        // 字段名对齐后端 schemas.ChatRequest（下划线命名）。
        // top_k / rerank_k 是可选字段，不传就让服务端用自己的配置。
        // enable_retry 是**三态**：undefined 表示"调用方没表态"，此时整个字段
        // 都不发（让服务端默认值生效）；显式 false 也必须发出去，否则用户
        // 关掉开关反而会被服务端默认值打开。
        body: {
          kb_id: request.kbId,
          question: request.question,
          // 会话历史真相源在服务端 Redis：带 conversation_id 时历史由服务端读，
          // 请求体不再发 history（发了也会被忽略，不如不发——少一个可漂移的字段）
          ...(request.conversationId ? { conversation_id: request.conversationId } : {}),
          ...(request.conversationId ? {} : { history: request.history ?? [] }),
          ...(request.topK !== undefined ? { top_k: request.topK } : {}),
          ...(request.rerankK !== undefined ? { rerank_k: request.rerankK } : {}),
          ...(request.enableRetry !== undefined ? { enable_retry: request.enableRetry } : {}),
        },
        signal: options.signal,
        idleTimeout: options.idleTimeout,
        skipAuth: options.skipAuth,
        errorToast: options.errorToast,
      },
      {
        onOpen: () => {
          handlers.onOpen?.()
        },
        onMessage: (message, controls) => {
          for (const event of toArray(decode(message))) {
            emit(event)
            handlers.onEvent?.(event)
            if (event.type === 'done') {
              controls.stop('done')
              return
            }
          }
        },
        onAbort: () => {
          aborted = true
          handlers.onAbort?.()
        },
      },
    )
  } catch (error) {
    const apiError = normalizeError(error)
    if (apiError.kind === 'canceled') {
      aborted = true
    } else {
      handlers.onError?.(apiError)
      throw apiError
    }
  }

  const finalResult = result()
  handlers.onDone?.(finalResult)
  return finalResult
}
