import { useCallback, useEffect, useRef } from 'react'

import { streamChat } from '../api'
import type { ChatHistoryTurn, ChatStreamOptions } from '../api'
import { useChatStore } from '../store/chat'
import type { ChatMessage } from '../store/chat'

/**
 * 流式问答的核心 Hook：把 SSE 事件流转成聊天消息状态。
 *
 * 职责边界（为什么拆成 Hook 而不是写在页面里）：
 *     「流式协议 ↔ UI 状态」的映射逻辑与「页面长什么样」是两件独立的事。
 *     放这里之后，页面只关心渲染，而 `stop()` / `retry` / 错误落盘这些
 *     容易写错的部分集中在一处，也便于单测。
 *
 * 三条关键约定：
 *
 * 1. **用户消息与助手空消息在发请求前就已入 store**（由页面的
 *    `claimSend()` 完成，本 Hook 只负责往同一个 assistantId 上追加）。
 *    否则首 token 前的几十秒里界面毫无反馈，用户会以为没点上。
 *    `claimSend()` 同时是**并发闸门**：已有流在跑时返回 false，
 *    所以连点两次发送不会产生两条并行的流。
 *
 * 2. **停止不是"丢弃"，是"收尾"**。
 *    用户点停止 → 中断连接，但已生成的文字**保留**并标记 `aborted`。
 *    把它当成失败清空，等于把用户等到的那段答案也没收了。
 *
 * 3. **组件卸载要真的断开**。
 *    离开页面时若不 abort，连接会一直挂着，后端继续跑推理并计费；
 *    回到页面还可能收到上一轮的残余 delta。
 *
 * 后端对应协议见 `api/modules/chat.ts`（事件：retry → sources → delta* → done/error）。
 */

export interface UseChatStreamOptions extends ChatStreamOptions {
  /** 目标知识库 ID（后端 kb_id 必填）；为空时不会发请求，而是直接在气泡里提示 */
  kbId?: string
  /**
   * 用户预设：首轮检索没找到时，是否允许「改写查询再检索一次」。
   *
   * **三态**，与后端请求字段一一对应：
   *  - `true` / `false`：用户的明确选择，服务端照办；
   *  - `undefined`：用户没表态 → 不发字段 → 服务端默认值生效
   *    （默认值从 `GET /chat/options` 读，见对话页）。
   *
   * 注意它不是「本次要不要重试」的唯一入口：用户在结果出来之后当场点
   * 「再找一次」会走 `retry()`，那一路固定传 `true`。
   */
  enableRetry?: boolean
}

export interface UseChatStreamResult {
  messages: ChatMessage[]
  isStreaming: boolean
  conversationId?: string
  /** 发送一轮提问；流式过程中增量会实时写入 store */
  send: (question: string) => Promise<void>
  /**
   * 对某条「还有额度」的助手消息当场再试一次：用同一个问题重发，
   * 并强制 `enable_retry=true`（用户此刻的选择压过预设开关）。
   */
  retry: (messageId: string) => Promise<void>
  /** 停止生成（保留已生成的部分） */
  stop: () => void
  /** 清空会话 */
  reset: () => void
}

/** 只把已经正常收尾的消息当上下文，免得把半截回答喂回给模型 */
function collectHistory(messages: ChatMessage[]): ChatHistoryTurn[] {
  return messages
    .filter((item) => item.status === 'done' && item.content.trim())
    .map((item) => ({ role: item.role, content: item.content }))
}

/**
 * 本地生成会话 ID（标准 UUID v4，与服务端 `str(uuid.uuid4())` 同格式）。
 *
 * 为什么要在前端先生成，而不是等服务端在 done 里回传：
 *   服务端回传要等一整轮问答结束。这期间 store 里是空值，任何「在你回答前
 *   就发了第二次请求」的路径（连点、断线重发、切换后立刻再问）都会各自
 *   无 ID 发出，服务端只能各生成一个新会话——同样的问答出现两份，
 *   内容还一模一样，用户完全无从判断该删哪条。
 *   提前落 ID 后，即便真的发出两次，两次携带的也是同一个会话 ID，
 *   append_turn 会按 ID 追加到同一处，最坏情况是消息重复而不是会话分裂。
 */
function newConversationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // 老 Safari / 非安全上下文（http 内网 IP）没有 randomUUID，退回手写 v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0
    const value = char === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

/**
 * 流式对话 hook。把 `streamChat` 的增量回调接到 `useChatStore` 上，
 * 组件只需要读 messages 渲染即可。
 *
 * 与后端的约定（多轮历史真相源在**服务端 Redis**）：
 *  1. 请求带 `conversation_id` → 服务端从 Redis 读历史送进提示词，回答连同
 *     溯源（文档名+页码）自动落库；请求体不发 history（发了也被忽略）；
 *  2. 首问不带 `conversation_id` → 服务端生成新 ID（首问也落库），
 *     从 `done` 事件的 `conversationId` 拿回来写进 store，下一轮带上；
 *  3. 服务端**未配置**会话存储（REDIS_URL 为空）时，done 里没有会话 ID →
 *     store 恒为空 → 每轮都走本地 history 兜底，行为与旧版一致——
 *     同一套代码对两种后端部署都成立，不需要前端探测能力；
 *  4. `enable_retry` 三态：省略 = 未表态（用服务端默认值），`false` 也必须显式发出去；
 *  5. 收尾的 `done` 事件回填 `retried/attempts/can_retry/query`，前端据此决定
 *     要不要问用户「再找一次」——不必让用户事先盲签一个开关。
 *
 * @param options 透传给 `streamChat` 的选项（decode / idleTimeout / endpoint / kbId / enableRetry 等）
 */
export function useChatStream(options: UseChatStreamOptions = {}): UseChatStreamResult {
  const messages = useChatStore((state) => state.messages)
  const isStreaming = useChatStore((state) => state.isStreaming)
  const conversationId = useChatStore((state) => state.conversationId)

  const controllerRef = useRef<AbortController | null>(null)
  // 用 ref 持有 options，避免把 options 放进 send 的依赖里导致回调频繁重建。
  // 注意只能在 effect 里写 ref，render 期间写会被 react-hooks 规则拦下。
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  // 组件卸载时中断进行中的流，避免内存泄漏与无效 setState
  useEffect(() => {
    return () => {
      controllerRef.current?.abort()
    }
  }, [])

  const stop = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    controllerRef.current?.abort()
    useChatStore.getState().reset()
  }, [])

  /**
   * 跑一轮流式问答，把增量写进**指定的**助手消息。
   *
   * 抽出来是因为「首次提问」与「当场再试一次」除了问题与 enableRetry
   * 不同，其余（增量落 store、收尾事实、错误处理）完全一样——
   * 写两份必然漂移，而漂移的后果是两条路的行为悄悄分叉。
   */
  const runTurn = useCallback(
    async (
      question: string,
      assistantId: string,
      history: ChatHistoryTurn[],
      enableRetry: boolean | undefined,
    ) => {
      const kbId = optionsRef.current.kbId
      if (!kbId) {
        // 正常走不到：send / retry 都会在抢锁之前挡住无 kbId 的情况。
        // 万一来到了这里，必须放锁——否则 claimSend 抢到的 isStreaming 会
        // 永久停在 true，界面从此发不出消息且没有任何报错。
        useChatStore.getState().finalizeMessage(assistantId, 'error', '请先选择要问答的知识库')
        useChatStore.getState().setStreaming(false)
        return
      }

      // 调用方（send / retry）已经用 claimSend() 原子地置位过 isStreaming，
      // 这里重复置位是幂等的，保留作为「万一有新调用方忘了抢」的兜底
      useChatStore.getState().setStreaming(true)
      const controller = new AbortController()
      controllerRef.current = controller

      try {
        const result = await streamChat(
          {
            kbId,
            question,
            // 首问不传 → 服务端生成并从 done 回传；续聊传 → 服务端读 Redis 历史
            conversationId: useChatStore.getState().conversationId,
            // 仅在「没有会话 ID」时才会被发出（streamChat 内部据此决定发不发），
            // 覆盖的是服务端未配置会话存储时的兜底场景；
            // history 必须由调用方在插入本轮消息之前收集好传进来
            history,
            enableRetry,
          },
          {
            onDelta: (chunk) => {
              useChatStore.getState().appendDelta(assistantId, chunk)
            },
            onEvent: (event) => {
              if (event.type === 'references') {
                useChatStore.getState().setReferences(assistantId, event.references)
              }
              if (event.type === 'meta' && event.conversationId) {
                useChatStore.getState().setConversationId(event.conversationId)
              }
            },
            onRetry: () => {
              // 改写要 2~4 秒，不提示的话用户会以为卡死了
              useChatStore.getState().setRetrying(assistantId, true)
            },
            onAbort: () => {
              useChatStore.getState().finalizeMessage(assistantId, 'aborted')
            },
            onError: (error) => {
              useChatStore.getState().finalizeMessage(assistantId, 'error', error.message)
            },
          },
          { ...optionsRef.current, signal: controller.signal },
      )

      if (!result.aborted) {
        // 首问的会话 ID 在这里落进 store——此后每一轮都会带上它，
        // 服务端才开始为这一组问答读历史/续写历史
        if (result.done?.conversationId) {
          useChatStore.getState().setConversationId(result.done.conversationId)
        }
        // 收尾事实要**先于** finalize 写入：finalizeMessage 只接受
        // 「streaming → 终态」这一次转换，反过来写提示就永远不会出现
        useChatStore.getState().applyTurnFacts(assistantId, {
          refused: result.done?.refused ?? false,
          retried: result.done?.retried ?? false,
          attempts: result.done?.attempts ?? 0,
          // 服务端没给 can_retry（老后端）时保守取 false：宁可少弹一次提示
          canRetry: result.done?.canRetry ?? false,
          query: result.done?.query || question,
        })
        useChatStore.getState().finalizeMessage(assistantId, 'done')
      }
    } catch {
      // 错误已经在 onError 里落到消息上了，这里不再重复处理
    } finally {
      useChatStore.getState().setStreaming(false)
      controllerRef.current = null
    }
  }, [])

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim()
      if (!trimmed) {
        return
      }

      // 抢占发送权：检查与置位是**一次同步写**（见 store.claimSend 的注释）。
      // 原先的 `if (store.isStreaming) return` 是非原子的读—写，连点两下会在
      // 同一帧内双双通过，发出两个不带会话 ID 的请求，各自新建一条会话。
      if (!useChatStore.getState().claimSend()) {
        return
      }

      const store = useChatStore.getState()

      if (!optionsRef.current.kbId) {
        // 没有知识库不发请求：后端的 kb_id 必填，发出去只会拿回 422。
        // 已经抢了发送权，这里必须放掉，否则界面会永远卡在"发送中"
        const assistantId = store.startAssistantMessage(trimmed)
        useChatStore.getState().finalizeMessage(assistantId, 'error', '请先选择要问答的知识库')
        useChatStore.getState().setStreaming(false)
        return
      }

      // 首轮先在本地落一个会话 ID：等服务端在 done 里回传的话，这期间发出的
      // 任何一次请求都不带 ID，服务端只能各建一个会话（重复会话根因之二）。
      // 提前落 ID 后，同一轮的所有请求都指向同一个会话。
      if (!useChatStore.getState().conversationId) {
        useChatStore.getState().setConversationId(newConversationId())
      }

      // 多轮上下文在**插入本轮消息之前**取，所以它天然不含本次提问；
      // 带会话 ID 时它不会被发出（服务端从 Redis 读），仅作兜底
      const history = collectHistory(store.messages)

      store.addUserMessage(trimmed)
      const assistantId = store.startAssistantMessage(trimmed)

      await runTurn(trimmed, assistantId, history, optionsRef.current.enableRetry)
    },
    [runTurn],
  )

  const retry = useCallback(
    async (messageId: string) => {
      const store = useChatStore.getState()
      const target = store.messages.find((item) => item.id === messageId)
      // canRetry 是唯一判据（服务端算的：拒答且额度没用满）。
      // 不满足就直接不动，免得给用户一个静默花掉 2~4 秒的响应
      if (!target?.canRetry) {
        return
      }
      const question = target.question?.trim()
      if (!question || !optionsRef.current.kbId) {
        return
      }
      // 与 send 同一套原子抢占：「再找一次」按钮同样会被连点，
      // 旧的 `if (store.isStreaming) return` 拦不住同一帧内的两次触发
      if (!useChatStore.getState().claimSend()) {
        return
      }

      const before = store.messages.slice(0, store.messages.findIndex((item) => item.id === messageId))
      // 丢掉紧邻的那条用户消息：它就是这次要重发的问题，会由 `question`
      // 单独送上去；留在 history 里等于把同一个问题问了两遍
      if (before.length > 0 && before[before.length - 1].role === 'user') {
        before.pop()
      }

      store.resetAssistantMessage(messageId)
      // 无论预设开关是开是关，用户**当场**点了「再找一次」就是要重试，
      // 所以显式传 true——这正是三态里"用户的选择压过服务端默认值"的用法
      await runTurn(question, messageId, collectHistory(before), true)
    },
    [runTurn],
  )

  return { messages, isStreaming, conversationId, send, retry, stop, reset }
}
