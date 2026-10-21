import { create } from 'zustand'

import type { ChatReference } from '../api'

export type ChatRole = 'user' | 'assistant'
export type ChatMessageStatus = 'streaming' | 'done' | 'aborted' | 'error'

/**
 * 服务端在一轮问答收尾时回填的事实（来自 SSE 的 `done` 事件）。
 * 全部字段都可缺省：老后端、被中断的流、加载出来的历史消息都没有它们。
 */
export interface ChatTurnFacts {
  /** 服务端说「资料不足，拒答」 */
  refused?: boolean
  /** 检索阶段是否**真的**用改写后的查询重新检索过（≠「调过改写」） */
  retried?: boolean
  /** 改写尝试次数（含「改写了但无产出」那一次） */
  attempts?: number
  /** 服务端认为还能再试一次（首轮没找到且额度没用满）→ 前端据此弹「再找一次」 */
  canRetry?: boolean
  /** 本轮实际用于检索的查询（发生过改写时与用户问题不同） */
  query?: string
}

export interface ChatMessage extends ChatTurnFacts {
  id: string
  role: ChatRole
  content: string
  status: ChatMessageStatus
  error?: string
  references?: ChatReference[]
  createdAt: number
  /**
   * 触发这轮回答的用户问题（只有助手消息有）。
   * 「再找一次」要原样重发同一个问题，把它存在消息上比回头去数组里
   * 找"上一条用户消息"稳——那条关系会被插入、重发、切换会话打乱。
   */
  question?: string
  /** 服务端正在改写查询重试（用来把那段 2~4 秒的静默显式化） */
  retrying?: boolean
}

interface ChatState {
  messages: ChatMessage[]
  conversationId?: string
  isStreaming: boolean
  addUserMessage: (content: string) => string
  /** 新建一条助手消息；`question` 是它要回答的问题（供「再找一次」用） */
  startAssistantMessage: (question?: string) => string
  /** 流式追加增量文本 */
  appendDelta: (id: string, chunk: string) => void
  setReferences: (id: string, references: ChatReference[]) => void
  /** 标记「服务端正在改写查询重试」 */
  setRetrying: (id: string, retrying: boolean) => void
  /** 收尾时写入服务端回填的重试事实 */
  applyTurnFacts: (id: string, facts: ChatTurnFacts) => void
  /** 用户点「不用了」：收起提示，但保留"确实拒答了"这个事实 */
  dismissRetry: (id: string) => void
  /** 「再找一次」前把这条消息清空复用（内容、引用、提示全部重置为流式态） */
  resetAssistantMessage: (id: string) => void
  finalizeMessage: (id: string, status: ChatMessageStatus, error?: string) => void
  setConversationId: (conversationId?: string) => void
  /**
   * 抢占一轮对话的「发送权」：**检查与置位在同一次同步 set 里完成**。
   *
   * 为什么不能用 `if (store.isStreaming) return` 再 `setStreaming(true)`：
   * 那是一对分开的「读—写」，两次快速触发（连点发送、回车+点击）会在同一
   * 事件循环里先后读到 `isStreaming === false`，双双通过检查，于是发出两个
   * 都不带 conversation_id 的请求，服务端各生成一个 uuid4 —— 这就是
   * 「同一问题出现两条一模一样的会话」的根因（实测：两份消息正文逐字相同）。
   *
   * zustand 的 `set` 是同步执行的，把判断放进取值函数里，第二个调用进来时
   * 第一个已经写入 isStreaming=true，因此本次拿不到发送权。
   *
   * @returns true = 抢到了，可以发请求；false = 已有一轮在跑，本次丢弃
   */
  claimSend: () => boolean
  setStreaming: (streaming: boolean) => void
  /** 把历史会话消息灌进 store（从对话历史页进入时用），流式状态统一置为 done */
  loadMessages: (messages: ChatMessage[], conversationId?: string) => void
  reset: () => void
}

let idCounter = 0

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  idCounter += 1
  return `msg-${Date.now()}-${idCounter}`
}

function patch(
  messages: ChatMessage[],
  id: string,
  updater: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((message) => (message.id === id ? updater(message) : message))
}

/**
 * 对话状态。流式过程中每个 token 都会 append 一次，
 * 这里用不可变更新，交由 zustand 通知订阅者。
 */
export const useChatStore = create<ChatState>()((set) => ({
  messages: [],
  conversationId: undefined,
  isStreaming: false,

  addUserMessage: (content) => {
    const id = createId()
    set((state) => ({
      messages: [
        ...state.messages,
        { id, role: 'user', content, status: 'done', createdAt: Date.now() },
      ],
    }))
    return id
  },

  startAssistantMessage: (question) => {
    const id = createId()
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id,
          role: 'assistant',
          content: '',
          status: 'streaming',
          createdAt: Date.now(),
          ...(question ? { question } : {}),
        },
      ],
    }))
    return id
  },

  appendDelta: (id, chunk) => {
    set((state) => ({
      messages: patch(state.messages, id, (message) => ({
        ...message,
        content: message.content + chunk,
        // 正文一到就说明改写已经结束，别让"正在重新检索"的提示粘在气泡上
        retrying: false,
      })),
    }))
  },

  setReferences: (id, references) => {
    set((state) => ({
      messages: patch(state.messages, id, (message) => ({ ...message, references })),
    }))
  },

  setRetrying: (id, retrying) => {
    set((state) => ({
      messages: patch(state.messages, id, (message) => ({ ...message, retrying })),
    }))
  },

  applyTurnFacts: (id, facts) => {
    set((state) => ({
      messages: patch(state.messages, id, (message) => ({
        ...message,
        ...facts,
        retrying: false,
      })),
    }))
  },

  dismissRetry: (id) => {
    set((state) => ({
      messages: patch(state.messages, id, (message) => ({ ...message, canRetry: false })),
    }))
  },

  resetAssistantMessage: (id) => {
    set((state) => ({
      messages: patch(state.messages, id, (message) => ({
        ...message,
        content: '',
        status: 'streaming',
        error: undefined,
        references: undefined,
        // 上一轮的结论全部清掉：这次要重新检索，canRetry 必须重新判定，
        // 否则「再找一次」的按钮会在请求还没回来时又冒出来（用户会连点）
        refused: undefined,
        retried: undefined,
        attempts: undefined,
        canRetry: undefined,
        query: undefined,
        retrying: false,
      })),
    }))
  },

  finalizeMessage: (id, status, error) => {
    set((state) => ({
      messages: patch(state.messages, id, (message) =>
        // 已经收尾过的消息不再被后续回调覆盖
        message.status === 'streaming' ? { ...message, status, error, retrying: false } : message,
      ),
    }))
  },

  setConversationId: (conversationId) => set({ conversationId }),

  claimSend: () => {
    // 判断与置位必须在同一个 set 里：拆成两步读/写就退化成非原子的检查，
    // 同一帧内的两次调用会双双通过（详见接口注释）。
    let claimed = false
    set((state) => {
      if (state.isStreaming) {
        return {}
      }
      claimed = true
      return { isStreaming: true }
    })
    return claimed
  },

  setStreaming: (isStreaming) => set({ isStreaming }),
  loadMessages: (messages, conversationId) =>
    set({
      messages: messages.map((message) => ({
        ...message,
        status: 'done' as const,
        retrying: false,
        // 历史消息不再提供「再找一次」：重发要带当时的上下文，而历史里
        // 只留了消息本身，重新发一遍等于换了个问题去问
        canRetry: false,
      })),
      conversationId,
      isStreaming: false,
    }),
  reset: () => set({ messages: [], conversationId: undefined, isStreaming: false }),
}))
