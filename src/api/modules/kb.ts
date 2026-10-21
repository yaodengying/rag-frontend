import { del, get, post, put } from '../http'

/**
 * 知识库管理接口。
 *
 * 对接 rag-backend 的 `/api/v1/knowledge-bases`：
 *     GET    /knowledge-bases            列表 → KnowledgeBaseOut[]
 *     POST   /knowledge-bases            新建 → KnowledgeBaseOut（201）
 *     PUT    /knowledge-bases/{kb_id}    更新名称/描述 → KnowledgeBaseOut
 *     DELETE /knowledge-bases/{kb_id}    删除（级联清理文档、向量与上传文件，204）
 *
 * 后端返回的 KnowledgeBaseOut 只有 `{ id, name, description, doc_count, created_at }`：
 *   - **没有** 切片数 / 引用次数 → 前端恒为 0，页面不再展示（不显示假数据）
 *   - **没有** 启用 / 归档状态 → 前端恒为 'enabled'，页面不再提供归档操作
 *   - **没有** /knowledge-bases/stats 汇总接口 → 统计卡片改为由列表数据本地聚合
 *     （见 `computeKbStats`），比多打一次接口更省事也更一致。
 */

export const KB_ENDPOINTS = {
  list: '/knowledge-bases',
  create: '/knowledge-bases',
  update: (id: string) => `/knowledge-bases/${id}`,
  remove: (id: string) => `/knowledge-bases/${id}`,
} as const

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  docCount: number
  /** 后端无此字段，恒为 0（保留以免页面类型大改） */
  chunkCount: number
  /** 后端无此字段，恒为 0 */
  quoteCount: number
  createdAt: string
  /** 后端无启停概念，恒为 enabled */
  status: 'enabled' | 'archived'
}

export interface KbStats {
  kbTotal: number
  kbEnabled: number
  docTotal: number
  chunkTotal: number
  quoteTotal: number
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) {
      return value
    }
    if (typeof value === 'number') {
      return String(value)
    }
  }
  return undefined
}

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return undefined
}

const ID_KEYS = ['id', 'kbId', 'kb_id', 'knowledge_base_id', 'uuid'] as const
const NAME_KEYS = ['name', 'title', 'kbName'] as const
const DESC_KEYS = ['description', 'desc', 'remark'] as const
const DOC_COUNT_KEYS = ['doc_count', 'docCount', 'document_count', 'documents'] as const
const CHUNK_COUNT_KEYS = ['chunk_count', 'chunkCount', 'chunks', 'slice_count'] as const
const QUOTE_COUNT_KEYS = ['quote_count', 'quoteCount', 'citation_count', 'hits'] as const
const CREATED_KEYS = ['created_at', 'createdAt', 'createTime', 'create_time'] as const
const STATUS_KEYS = ['status', 'state'] as const

/** ISO 时间串 → 本地 `YYYY-MM-DD HH:mm:ss`；非 ISO 输入原样返回 */
function formatCreatedAt(value: string): string {
  if (!value || !value.includes('T')) {
    return value
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** 后端字段名兼容归一化 */
export function normalizeKb(raw: unknown): KnowledgeBase {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const status = pickString(record, STATUS_KEYS)
  return {
    id: pickString(record, ID_KEYS) ?? '',
    name: pickString(record, NAME_KEYS) ?? '未命名知识库',
    description: pickString(record, DESC_KEYS) ?? '',
    docCount: pickNumber(record, DOC_COUNT_KEYS) ?? 0,
    chunkCount: pickNumber(record, CHUNK_COUNT_KEYS) ?? 0,
    quoteCount: pickNumber(record, QUOTE_COUNT_KEYS) ?? 0,
    createdAt: formatCreatedAt(pickString(record, CREATED_KEYS) ?? ''),
    status: status === 'archived' || status === 'disabled' ? 'archived' : 'enabled',
  }
}

/**
 * 由知识库列表本地聚合出统计数字。
 *
 * 后端没有汇总接口，且列表里本来就带了 doc_count，聚合比再打一次接口更快、也不会出现
 * 「列表与统计对不上」的中间态。切片数与引用次数后端无数据来源，恒为 0。
 */
export function computeKbStats(kbs: KnowledgeBase[]): KbStats {
  return {
    kbTotal: kbs.length,
    kbEnabled: kbs.filter((kb) => kb.status === 'enabled').length,
    docTotal: kbs.reduce((sum, kb) => sum + kb.docCount, 0),
    chunkTotal: kbs.reduce((sum, kb) => sum + kb.chunkCount, 0),
    quoteTotal: kbs.reduce((sum, kb) => sum + kb.quoteCount, 0),
  }
}

export async function listKnowledgeBases(options?: { signal?: AbortSignal }): Promise<KnowledgeBase[]> {
  const data = await get<unknown[]>(KB_ENDPOINTS.list, undefined, {
    signal: options?.signal,
    skipErrorToast: true,
  })
  return (Array.isArray(data) ? data : []).map(normalizeKb)
}

export async function createKnowledgeBase(payload: {
  name: string
  description?: string
}): Promise<KnowledgeBase> {
  const data = await post<unknown>(
    KB_ENDPOINTS.create,
    { name: payload.name, description: payload.description ?? '' },
    { skipErrorToast: true },
  )
  return normalizeKb(data)
}

/**
 * 更新知识库名称与描述。
 *
 * 后端是整体替换语义（PUT 要求 name 必填），所以调用方必须把两个字段都传全，
 * 只改描述时也要带上原名称。
 */
export async function updateKnowledgeBase(
  id: string,
  payload: { name: string; description?: string },
): Promise<KnowledgeBase> {
  const data = await put<unknown>(
    KB_ENDPOINTS.update(id),
    { name: payload.name, description: payload.description ?? '' },
    { skipErrorToast: true },
  )
  return normalizeKb(data)
}

export async function deleteKnowledgeBase(id: string): Promise<void> {
  await del(KB_ENDPOINTS.remove(id), undefined, { skipErrorToast: true })
}
