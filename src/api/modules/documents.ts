import { del, get, post } from '../http'

/**
 * 文档管理接口。
 *
 * 对接 rag-backend（文档挂在知识库下，kb_id 是路径参数、**必填**）：
 *     GET    /knowledge-bases/{kb_id}/documents         列表 → DocumentOut[]
 *     POST   /knowledge-bases/{kb_id}/documents         单文件上传（表单字段名 file）
 *     POST   /knowledge-bases/{kb_id}/documents/batch   批量上传（表单字段名 files）
 *     DELETE /documents/{doc_id}                        删除 → 204
 *
 * 后端 DocumentOut 只有
 *     `{ id, kb_id, filename, status, chunk_count, error, created_at }`
 * 因此：
 *   - **没有** type 字段 → 从 filename 后缀推断；
 *   - **没有** size 字段 → sizeText 恒为 '—'，页面不再展示（不显示假数据）；
 *   - status 取值是 `processing / ready / failed`（**ready** 而非 done），
 *     本模块统一归一化成前端的 `processing / done / failed`；
 *   - **没有** 重新解析接口 → 该能力已从页面移除。
 *
 * 列表接口不支持 status / keyword 过滤，筛选一律在前端本地做（文档量在可接受范围内）。
 */

export const DOCUMENT_ENDPOINTS = {
  list: (kbId: string) => `/knowledge-bases/${kbId}/documents`,
  upload: (kbId: string) => `/knowledge-bases/${kbId}/documents`,
  remove: (id: string) => `/documents/${id}`,
} as const

/** 与后端 UPLOAD_ALLOWED_EXTENSIONS 对齐：.pdf / .docx / .txt / .md / .pptx */
export type DocumentType = 'pdf' | 'docx' | 'txt' | 'md' | 'pptx'
export type DocumentStatus = 'pending' | 'processing' | 'done' | 'failed'

/** 后端认可的扩展名白名单（带点、小写）。页面据此在上传前先拦一道。 */
export const DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.pptx'] as const

const SUPPORTED_EXTENSIONS = new Set<string>(DOCUMENT_EXTENSIONS)

/**
 * 文件选择框的 accept 串。
 *
 * Windows 上只写扩展名时，排在最前面的 `.pdf` 常被当成过滤器「名称」而选不中文件，
 * 因此这里同时声明 MIME，并把 `.pdf` 再放到末尾兜底（沿用参考工程 ai-knowledge-rag 的做法）。
 */
export const UPLOAD_ACCEPT = [
  'application/pdf',
  '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.docx',
  'text/plain',
  '.txt',
  'text/markdown',
  '.md',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pptx',
  '.pdf',
].join(',')

/** 扩展名是否在后端白名单内（仅看后缀，不看 MIME —— 浏览器给的 MIME 并不可靠） */
export function isSupportedDocument(filename: string): boolean {
  const index = filename.lastIndexOf('.')
  return index >= 0 && SUPPORTED_EXTENSIONS.has(filename.slice(index).toLowerCase())
}

export interface KnowledgeDocument {
  id: string
  kbId?: string
  filename: string
  type: DocumentType
  /** 展示用的大小文本；后端不返回体积，恒为 '—' */
  sizeText: string
  uploadedAt: string
  status: DocumentStatus
  chunkCount: number
  /** 解析失败时的原因（后端 error 字段） */
  error?: string
}

export const DOCUMENT_STATUS_TEXT: Record<DocumentStatus, string> = {
  pending: '排队中',
  processing: '解析中',
  done: '已完成',
  failed: '失败',
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) {
      return value
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
  }
  return undefined
}

const ID_KEYS = ['id', 'docId', 'doc_id', 'document_id', 'uuid'] as const
const NAME_KEYS = ['filename', 'fileName', 'file_name', 'name', 'title'] as const
const TYPE_KEYS = ['type', 'fileType', 'file_type', 'ext', 'extension'] as const
const UPLOADED_KEYS = ['created_at', 'uploadedAt', 'uploaded_at', 'uploadTime', 'create_time'] as const
const STATUS_KEYS = ['status', 'state', 'processStatus'] as const
const CHUNK_KEYS = ['chunk_count', 'chunkCount', 'chunks', 'slice_count'] as const

/** 从文件名或扩展名字段推断类型 */
export function normalizeType(value: string | undefined): DocumentType {
  const ext = (value ?? '').toLowerCase().replace(/^\./, '')
  if (ext === 'pdf' || ext === 'docx' || ext === 'txt' || ext === 'md' || ext === 'pptx') {
    return ext
  }
  return 'txt'
}

/**
 * 后端状态 → 前端状态。
 * 后端的 `ready` 表示「解析完成、可检索」，对应前端的 `done`。
 */
function normalizeStatus(value: string | undefined): DocumentStatus {
  const status = (value ?? '').toLowerCase()
  if (['ready', 'done', 'completed', 'success', 'finished'].includes(status)) {
    return 'done'
  }
  if (['processing', 'parsing', 'running'].includes(status)) {
    return 'processing'
  }
  if (['failed', 'error'].includes(status)) {
    return 'failed'
  }
  return 'pending'
}

export function normalizeDocument(raw: unknown): KnowledgeDocument {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const filename = pickString(record, NAME_KEYS) ?? '未命名文件'
  // 后端不带 type 字段，用显式的类型字段优先，缺失时从文件名后缀推断
  const typeSource = pickString(record, TYPE_KEYS) ?? filename
  return {
    id: pickString(record, ID_KEYS) ?? '',
    kbId: pickString(record, ['kb_id', 'kbId', 'knowledge_base_id']),
    filename,
    type: normalizeType(typeSource.includes('/') ? typeSource : typeSource.split('.').pop()),
    sizeText: '—',
    uploadedAt: pickString(record, UPLOADED_KEYS) ?? '',
    status: normalizeStatus(pickString(record, STATUS_KEYS)),
    chunkCount: pickNumber(record, CHUNK_KEYS) ?? 0,
    error: pickString(record, ['error', 'error_message', 'reason']) ?? '',
  }
}

export interface DocumentListParams {
  /** 后端按知识库取文档，kb_id 必填 */
  kbId: string
  signal?: AbortSignal
}

/** 列出某知识库下的文档（后端不支持 status / keyword 过滤，筛选请在页面本地做） */
export async function listDocuments(params: DocumentListParams): Promise<KnowledgeDocument[]> {
  const data = await get<unknown[]>(DOCUMENT_ENDPOINTS.list(params.kbId), undefined, {
    signal: params.signal,
    skipErrorToast: true,
  })
  return (Array.isArray(data) ? data : []).map(normalizeDocument)
}

export interface UploadDocumentOptions {
  /**
   * 字节传输进度（0-100）。
   * 注意：后端是**同步**入库（解析→切分→向量化→落库都在请求内完成），
   * 所以进度到 100% 只代表字节发完了，请求仍要等后端索引结束才返回。
   */
  onProgress?: (percent: number) => void
  signal?: AbortSignal
}

/**
 * 上传单个文档（表单字段名 file）。
 *
 * 与批量接口的分工：批量接口一次把 N 个文件发出去，拿不到单个文件的进度，
 * 且只有等整批返回才知道结果。页面要逐文件展示「上传中 → 解析中 → 完成/失败」，
 * 所以走这个单文件接口。
 *
 * 后端批量入库本身也是**串行**循环（`IngestService.ingest_batch`），
 * 逐文件上传并不会比批量更慢，因此页面按顺序一个个传，顺便避免并发打满 CPU 侧的向量化。
 *
 * 失败语义（两条路径都要处理）：
 *   - 入口校验失败（扩展名/超限/库不存在）→ 非 2xx，这里 reject 成 ApiError；
 *   - 流水线内部失败 → 仍是 2xx，但返回的文档 status=failed 且带 error 原因。
 */
export async function uploadDocument(
  file: File,
  kbId: string,
  options: UploadDocumentOptions = {},
): Promise<KnowledgeDocument> {
  const form = new FormData()
  form.append('file', file)
  const data = await post<unknown>(DOCUMENT_ENDPOINTS.upload(kbId), form, {
    skipErrorToast: true,
    signal: options.signal,
    onUploadProgress: (event) => {
      if (!options.onProgress) {
        return
      }
      // total 在部分浏览器/代理下拿不到，此时不报进度，避免进度条永远停在 0 又突然满格
      if (!event.total) {
        return
      }
      options.onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)))
    },
  })
  return normalizeDocument(data)
}

export async function deleteDocument(id: string): Promise<void> {
  await del(DOCUMENT_ENDPOINTS.remove(id), undefined, { skipErrorToast: true })
}
