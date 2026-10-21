/**
 * 请求层统一出口。
 * 业务代码一律 `import { get, post } from '@/api'`（或相对路径），
 * 不要直接 import axios。
 */

export { BASE_URL, TIMEOUT, LOGIN_PATH, UNAUTHORIZED_EVENT, default as http, del, get, patch, post, put } from './http'

export { ApiError, getErrorMessage, isApiError, isCanceled, normalizeError, pickBackendMessage } from './error'
export type { ApiErrorInit, ApiErrorKind } from './error'

export { SUCCESS_CODES } from './types'
export type { ApiResponse } from './types'

export { REDIRECT_TO_LOGIN_ON_401, handleUnauthorized, setUnauthorizedHandler } from './unauthorized'

// 登录 / 登出 / 当前用户
export {
  AUTH_ENDPOINTS,
  fetchCurrentUser,
  login,
  logout,
  normalizeExpiresAt,
  normalizeLoginResult,
  normalizeUser,
} from './modules/auth'
export type { LoginOptions, LoginPayload, LoginResult } from './modules/auth'

// SSE 传输层
export { DEFAULT_IDLE_TIMEOUT, streamSSE } from './sse'
export type { SSEHandlers, SSEMessageControls, SSEOptions } from './sse'

// RAG 流式对话
export {
  CHAT_ENDPOINT,
  CHAT_OPTIONS_ENDPOINT,
  decodeChatChunk,
  fetchChatOptions,
  normalizeChatOptions,
  normalizeReference,
  streamChat,
} from './modules/chat'
export type {
  ChatDoneInfo,
  ChatHistoryTurn,
  ChatOptions,
  ChatReference,
  ChatRequest,
  ChatStreamEvent,
  ChatStreamHandlers,
  ChatStreamOptions,
  ChatStreamResult,
} from './modules/chat'

// 知识库管理
export {
  KB_ENDPOINTS,
  computeKbStats,
  createKnowledgeBase,
  deleteKnowledgeBase,
  listKnowledgeBases,
  normalizeKb,
  updateKnowledgeBase,
} from './modules/kb'
export type { KbStats, KnowledgeBase } from './modules/kb'

// 文档管理
export {
  DOCUMENT_ENDPOINTS,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_STATUS_TEXT,
  UPLOAD_ACCEPT,
  deleteDocument,
  isSupportedDocument,
  listDocuments,
  normalizeDocument,
  normalizeType,
  uploadDocument,
} from './modules/documents'
export type {
  DocumentListParams,
  DocumentStatus,
  DocumentType,
  KnowledgeDocument,
  UploadDocumentOptions,
} from './modules/documents'

// 对话历史（服务端 Redis 持久化；写发生在问答链路里，这里只读与删）
export {
  deleteConversation,
  getConversation,
  listConversations,
  summarizeChatStats,
} from './modules/conversations'
export type {
  ChatStats,
  ConversationDetail,
  ConversationSummary,
  HistoryMessage,
} from './modules/conversations'
