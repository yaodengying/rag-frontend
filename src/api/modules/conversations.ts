import { ApiError } from '../error'
import { del, get } from '../http'
// 引用归一化只有一份（chat.ts）：历史消息与即时回答必须是同一套字段映射，
// 在这里抄第二份迟早漂移（典型症状：即时回答有页码、翻历史没有）
import { normalizeReference } from './chat'
import type { ChatReference } from './chat'

/**
 * 对话历史：**服务端 Redis 持久化**（后端 /conversations 一族接口）。
 *
 * 迁移说明（为什么签名和旧版 localStorage 版一模一样）：
 *   旧版把会话存进 localStorage，对外却是 async 函数——当时就是按「将来换
 *   HTTP」预留的形状。现在后端有了会话存储（问答落库 + 本模块读删），
 *   只换实现不动调用方：页面代码一行不用改。
 *
 * 分工（别把「写」也搬到前端来）：
 *   会话的**写**发生在问答链路里——/chat/stream 回答收尾时，服务端把
 *   user+assistant 两轮连同溯源（文档名+页码）写进 Redis。前端发一次
 *   请求就少一个可漏的保存步骤；本模块只负责「翻历史」的读与删。
 *
 * 溯源字段：
 *   历史消息里 assistant 的 `references` 与即时回答用同一套形状
 *   （title=文件名、page=页码标签），换时间、换设备翻历史都能核对页码。
 */

const BASE = '/conversations'

export interface ConversationSummary {
  id: string
  title: string
  /** 最近一次提问针对的知识库 */
  kbId?: string
  /** 形如 2026-10-17 12:00:00 */
  updatedAt: string
  messageCount: number
  /** 本会话全部回答携带的引用总条数（知识库页统计的数据源） */
  citationCount: number
}

/** 历史消息。与聊天页的 ChatMessage 解耦，避免历史数据带上流式状态字段 */
export interface HistoryMessage {
  /** 历史数据在服务端没有 id（按序存储），由本模块按位置补一个 */
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  references?: ChatReference[]
}

export interface ConversationDetail extends ConversationSummary {
  createdAt: string
  messages: HistoryMessage[]
}

/* ------------------------------------------------------------------ *
 * snake_case → 驼峰归一化
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function num(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 服务端 StoredMessageOut → 前端 HistoryMessage（citations 与即时引用同形状） */
function normalizeMessage(raw: unknown, index: number): HistoryMessage {
  const record = asRecord(raw)
  const citations = Array.isArray(record.citations) ? record.citations : []
  return {
    // 服务端消息没有 id；列表渲染需要稳定的 key，按位置补一个即可
    id: `hist-${index}`,
    role: record.role === 'assistant' ? 'assistant' : 'user',
    content: str(record, 'content'),
    createdAt: str(record, 'created_at'),
    // 空引用不占位：user 消息 citations 恒为空，别让历史消息都挂一个空列表
    ...(citations.length > 0 ? { references: citations.map(normalizeReference) } : {}),
  }
}

function normalizeSummary(raw: unknown): ConversationSummary {
  const record = asRecord(raw)
  return {
    id: str(record, 'id'),
    title: str(record, 'title') || '新会话',
    kbId: str(record, 'kb_id') || undefined,
    updatedAt: str(record, 'updated_at'),
    messageCount: num(record, 'message_count'),
    citationCount: num(record, 'citation_count'),
  }
}

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

/** 会话列表（按最近更新倒序）。Redis 未配置时后端报 503，原样抛给调用方 */
export async function listConversations(options?: {
  kbId?: string
  keyword?: string
}): Promise<ConversationSummary[]> {
  const params: Record<string, string> = {}
  if (options?.kbId) {
    params.kb_id = options.kbId
  }
  if (options?.keyword?.trim()) {
    params.keyword = options.keyword.trim()
  }
  const raw = await get<unknown[]>(BASE, params)
  return (Array.isArray(raw) ? raw : []).map(normalizeSummary)
}

/** 会话详情（消息按时间正序）。404 = 不存在或已过期 */
export async function getConversation(id: string): Promise<ConversationDetail> {
  if (!id) {
    throw new ApiError({ kind: 'business', message: '会话不存在或已被删除' })
  }
  const raw = await get<unknown>(`${BASE}/${encodeURIComponent(id)}`)
  const record = asRecord(raw)
  const summary = normalizeSummary(record)
  const messages = Array.isArray(record.messages) ? record.messages : []
  return {
    ...summary,
    createdAt: str(record, 'created_at'),
    messages: messages.map(normalizeMessage),
  }
}

/** 删除会话（后端幂等：不存在也返回 204） */
export async function deleteConversation(id: string): Promise<void> {
  await del(`${BASE}/${encodeURIComponent(id)}`, undefined, { skipErrorToast: true })
}

/* ------------------------------------------------------------------ *
 * 统计（替代旧版 readLocalChatStats：数据源从 localStorage 换成服务端）
 * ------------------------------------------------------------------ */

export interface ChatStats {
  /** 会话总数 */
  conversationCount: number
  /** 所有回答携带的引用条数总和（知识库页「累计引用」卡的数据源） */
  citationTotal: number
  /** 按知识库分桶的引用条数；未记录 kbId 的会话不计入任何桶 */
  citationsByKb: Record<string, number>
}

/**
 * 从会话列表聚合统计。
 *
 * 口径与旧版一致：一条 assistant 回答里的每条引用计 1 次——
 * 服务端把 citation_count 存在会话元数据里（落库时累加），不用再拉详情。
 */
export function summarizeChatStats(summaries: ConversationSummary[]): ChatStats {
  const stats: ChatStats = { conversationCount: 0, citationTotal: 0, citationsByKb: {} }
  for (const item of summaries) {
    stats.conversationCount += 1
    stats.citationTotal += item.citationCount
    if (item.kbId) {
      stats.citationsByKb[item.kbId] = (stats.citationsByKb[item.kbId] ?? 0) + item.citationCount
    }
  }
  return stats
}
