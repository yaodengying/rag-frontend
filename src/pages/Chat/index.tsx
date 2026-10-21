import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentRef, KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router'
import {
  InfoCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  SendOutlined,
  StopOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { App as AntdApp, Avatar, Button, Input, Select, Spin, Switch, Tag, Tooltip } from 'antd'

import {
  fetchChatOptions,
  getConversation,
  getErrorMessage,
  isCanceled,
  listConversations,
  listKnowledgeBases,
} from '../../api'
import type { ChatOptions, ConversationSummary, KnowledgeBase } from '../../api'
import { useAuthStore } from '../../store/auth'
import { useChatStore } from '../../store/chat'
import type { ChatMessage } from '../../store/chat'
import { useChatStream } from '../../hooks/useChatStream'
import './chat.css'

/**
 * 页面 3：智能问答。
 * 结构对齐原型：左侧会话列表 + 右侧消息流（引用来源溯源）+ 底部输入区。
 * 发送走流式接口（`streamChat` → SSE，见 hooks/useChatStream.ts）。
 */

function formatTime(value: number | string): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value.replace(/-/g, '/'))
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

function scorePercent(score: number | undefined): string {
  if (score === undefined || !Number.isFinite(score)) {
    return '—'
  }
  return `${Math.round(score <= 1 ? score * 100 : score)}%`
}

/** 引用来源卡片（进度条呈现相关度） */
function ReferenceList({ references }: { references: NonNullable<ChatMessage['references']> }) {
  return (
    <div className="chat-references">
      <div className="chat-references__title">引用来源 ({references.length})</div>
      {references.map((reference, index) => (
        <div key={reference.id ?? index} className="chat-reference">
        <div className="chat-reference__head">
          <span className="chat-reference__index">[{index + 1}]</span>
          <span className="chat-reference__name">{reference.title ?? '未知来源'}</span>
          {/* 溯源页码：即时回答（source 事件）与历史回放（citations）同一形状，
              都经 normalizeReference 归一——页码缺失（如 txt 无页边界）时不显示 */}
          {typeof reference.page === 'string' && reference.page && (
            <span className="chat-reference__page">{reference.page}</span>
          )}
          <span className="chat-reference__score">{scorePercent(reference.score)}</span>
        </div>
          {reference.content && <p className="chat-reference__snippet">{reference.content}</p>}
          {typeof reference.score === 'number' && (
            <div className="chat-reference__bar">
              <div
                className="chat-reference__bar-inner"
                style={{ width: `${Math.min(100, Math.max(0, reference.score <= 1 ? reference.score * 100 : reference.score))}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function MessageBubble({
  message,
  onRetry,
  onDismissRetry,
}: {
  message: ChatMessage
  onRetry: (id: string) => void
  onDismissRetry: (id: string) => void
}) {
  const isUser = message.role === 'user'
  const timeText = formatTime(message.createdAt)
  const streaming = message.status === 'streaming'
  const showReferences = !isUser && !!message.references && message.references.length > 0

  return (
    <div className={`chat-message chat-message--${message.role}`}>
      <Avatar
        size={32}
        className={isUser ? 'chat-avatar chat-avatar--user' : 'chat-avatar chat-avatar--bot'}
        icon={isUser ? <UserOutlined /> : <RobotOutlined />}
      />
      <div className="chat-message__body">
        <div
          className={`chat-bubble ${isUser ? 'chat-bubble--user' : 'chat-bubble--bot'}${
            message.refused ? ' chat-bubble--refused' : ''
          }`}
        >
          {streaming && !message.content ? (
            <span className="chat-thinking">
              <Spin size="small" />
              {/* 改写要 2~4 秒，明说比让用户看"正在思考"干等要好 */}
              {message.retrying ? '首轮没找到，正在改写查询后重新检索...' : '正在思考...'}
            </span>
          ) : (
            <span
              className={`chat-bubble__text${streaming ? ' chat-bubble__text--streaming' : ''}`}
            >
              {message.content}
            </span>
          )}
          {streaming && message.retrying && message.content && (
            <span className="chat-bubble__notice">正在改写查询后重新检索...</span>
          )}
          {message.status === 'error' && (
            <span className="chat-bubble__error">回答出错：{message.error ?? '未知错误'}</span>
          )}
          {message.status === 'aborted' && <span className="chat-bubble__aborted">（已停止生成）</span>}
        </div>

        {/* 「当场询问」入口：只有服务端说还能再试（can_retry）时才出现。
            它和顶栏的预设开关是两条互补的路——开关是"以后都这样"，
            这里是"这一问再试一次"，所以固定按 enable_retry=true 重发。 */}
        {!isUser && message.status === 'done' && message.canRetry && (
          <div className="chat-retry-hint">
            <span className="chat-retry-hint__text">
              知识库里没检索到相关内容，要不要换个说法再找一次？
            </span>
            <div className="chat-retry-hint__actions">
              <Button
                size="small"
                type="primary"
                icon={<ReloadOutlined />}
                onClick={() => onRetry(message.id)}
              >
                再找一次
              </Button>
              <Button size="small" type="text" onClick={() => onDismissRetry(message.id)}>
                不用了
              </Button>
            </div>
          </div>
        )}

        {/* 改写过就说清楚"拿什么去查的"，否则用户会以为回答是凭空来的 */}
        {!isUser && message.retried && (
          <div className="chat-retried">
            已用改写后的查询重新检索{message.query ? `：「${message.query}」` : ''}
          </div>
        )}

        {showReferences && <ReferenceList references={message.references!} />}

        {timeText && <div className="chat-message__time">{timeText}</div>}
      </div>
    </div>
  )
}

export default function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { message: notify } = AntdApp.useApp()
  const username = useAuthStore((state) => state.user?.username)

  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listKeyword, setListKeyword] = useState('')
  const [input, setInput] = useState('')
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [kbId, setKbId] = useState('')
  /**
   * 服务端的问答能力清单（`GET /chat/options`）。
   * `null` = 没读到（还在读 或 读失败）→ 开关不可用，也不发 `enable_retry`，
   * 等于完全跟随服务端默认值。**关键点是不要在前端写死一份默认值**：
   * 抄一份的后果是界面上开着、后端其实没重试，而且没有任何报错。
   */
  const [chatOptions, setChatOptions] = useState<ChatOptions | null>(null)
  const [optionsLoading, setOptionsLoading] = useState(true)
  /** 用户的选择。`undefined` = 未表态（不发字段，服务端默认值生效） */
  const [retryEnabled, setRetryEnabled] = useState<boolean | undefined>(undefined)

  const { messages, isStreaming, conversationId, send, retry, stop, reset } = useChatStream({
    // 后端问答的 kb_id 是必填项，把选中的知识库透传给流式请求
    kbId: kbId || undefined,
    // 未表态时不发 enable_retry，让服务端默认值生效
    enableRetry: retryEnabled,
    // 错误已经在消息气泡里就地展示，不需要再弹全局提示
    errorToast: false,
  })
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<ComponentRef<typeof Input.TextArea> | null>(null)

  const activeId = searchParams.get('id') ?? ''

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeId),
    [conversations, activeId],
  )

  const loadList = useCallback(
    async (keyword?: string) => {
      setListLoading(true)
      try {
        const list = await listConversations({ keyword: keyword || undefined })
        setConversations(list)
      } catch (error) {
        void notify.error(getErrorMessage(error))
      } finally {
        setListLoading(false)
      }
    },
    [notify],
  )

  useEffect(() => {
    void loadList()
  }, [loadList])

  // 问答必须指定知识库（后端 kb_id 必填），拉列表后默认选中第一个
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const list = await listKnowledgeBases({ signal: controller.signal })
        setKbs(list)
        setKbId((current) => current || list[0]?.id || '')
      } catch (error) {
        if (!isCanceled(error)) {
          void notify.error(getErrorMessage(error))
        }
      }
    })()
    return () => controller.abort()
  }, [notify])

  // 会话列表关键词搜索：输入防抖 250ms 后按关键词重新拉取
  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(listKeyword.trim() || undefined), 250)
    return () => window.clearTimeout(timer)
  }, [listKeyword, loadList])

  // 读服务端的问答能力清单，给「检索不到时改写重试」的开关一个正确初值。
  // 这个请求失败不影响问答本身：读不到就**不表态**（请求不带 enable_retry，
  // 服务端默认值照常生效），开关置灰并说明原因——绝不猜一个可能相反的值写上去。
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const options = await fetchChatOptions({ signal: controller.signal })
        if (controller.signal.aborted) {
          return
        }
        setChatOptions(options)
        setRetryEnabled(options.streamRetryDefault)
      } catch (error) {
        // 取消（StrictMode 双挂载 / 离开页面）不算失败，别把开关误标成不可用
        if (isCanceled(error)) {
          return
        }
        setChatOptions(null)
      } finally {
        if (!controller.signal.aborted) {
          setOptionsLoading(false)
        }
      }
    })()
    return () => controller.abort()
  }, [])

  // 选中历史会话时从服务端拉取消息灌进 store（历史存在后端 Redis，
  // assistant 消息带溯源：references 里是文件名+页码）。
  // loadMessages 会把会话 ID 写进 store——此后继续提问就续在这条会话上，
  // 服务端会把这段历史送进提示词，不再依赖本地消息拼上下文。
  useEffect(() => {
    if (!activeId) {
      return
    }
    let alive = true
    void (async () => {
      try {
        const detail = await getConversation(activeId)
        if (!alive) {
          return
        }
        useChatStore.getState().loadMessages(
          detail.messages.map((item) => ({
            id: item.id,
            role: item.role,
            content: item.content,
            status: 'done' as const,
            references: item.references,
            createdAt: new Date(item.createdAt.replace(/-/g, '/')).getTime() || Date.now(),
          })),
          detail.id,
        )
      } catch (error) {
        if (alive) {
          void notify.error(getErrorMessage(error))
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [activeId, notify])

  // 消息变化时滚到底部
  useEffect(() => {
    const container = messagesRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [messages])

  const selectConversation = useCallback(
    (id: string) => {
      setSearchParams(id ? { id } : {})
      if (!id) {
        reset()
      }
    },
    [setSearchParams, reset],
  )

  async function handleSend() {
    const question = input.trim()
    // 这里只挡空输入：防重入交给 useChatStream 内部的 claimSend 原子抢占
    // （本层的 isStreaming 是渲染快照，同一帧内的两次触发都读到旧值，
    //  放这里判并不能真正拦住连点）
    if (!question) {
      return
    }
    setInput('')
    await send(question)
    // 第一轮对话后刷新会话列表，让新会话出现在左侧
    void loadList(listKeyword.trim() || undefined)
  }

  // 「再找一次」：让 hook 用同一个问题带 enable_retry=true 重发
  const handleRetry = useCallback(
    (id: string) => {
      void retry(id)
    },
    [retry],
  )

  // 「不用了」：只收起提示，不改写服务端给的拒答事实
  const handleDismissRetry = useCallback((id: string) => {
    useChatStore.getState().dismissRetry(id)
  }, [])

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void handleSend()
    }
  }

  function handleNewConversation() {
    reset()
    setSearchParams({})
    inputRef.current?.focus()
  }

  const headerTitle = activeConversation?.title ?? (conversationId ? '当前会话' : '新会话')

  const retryTip = chatOptions
    ? `开启后：第一轮检索没找到内容时，自动把你的问题改写一遍再检索一次（最多 ${chatOptions.streamRetryMaxAttempts} 次），代价是多等 2~4 秒。` +
      '关闭后：这轮就到此为止，但答案出来时若还能再试，气泡里会给你一个「再找一次」。' +
      (chatOptions.nonStreamAlwaysRetries ? '（非流式的 /chat 接口恒重试一次，与这个开关无关）' : '')
    : optionsLoading
      ? '正在读取服务端的默认值…'
      : '没能读到服务端的默认值，这个开关暂不可用；当前请求不指定该项，按服务端默认行为执行。'

  return (
    <div className="chat-page">
      {/* ---------------- 左侧会话列表 ---------------- */}
      <aside className="chat-side">
        <Button type="primary" block icon={<PlusOutlined />} className="chat-new-btn" onClick={handleNewConversation}>
          新建会话
        </Button>
        <Input
          className="chat-side__search"
          placeholder="搜索会话..."
          prefix={<SearchOutlined className="chat-side__search-icon" />}
          allowClear
          value={listKeyword}
          onChange={(event) => setListKeyword(event.target.value)}
        />
        <div className="chat-side__list">
          {listLoading ? (
            <div className="chat-side__loading">
              <Spin size="small" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="chat-side__empty">暂无历史会话</div>
          ) : (
            conversations.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`chat-side__item${item.id === activeId ? ' chat-side__item--active' : ''}`}
                onClick={() => selectConversation(item.id)}
              >
                <span className="chat-side__item-title">{item.title}</span>
                <span className="chat-side__item-time">{item.updatedAt}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* ---------------- 右侧对话区 ---------------- */}
      <section className="chat-main">
        <header className="chat-header">
          <div className="chat-header__left">
            <span className="chat-header__icon">
              <RobotOutlined />
            </span>
            <div>
              <div className="chat-header__title">{headerTitle}</div>
              <div className="chat-header__subtitle">基于知识库回答问题</div>
            </div>
          </div>
          <div className="chat-header__right">
            {/* 预设开关：把"以后都这样"交给用户。初值取服务端默认值，
                用户改过之后每次请求都显式带上 enable_retry。 */}
            <div className="chat-retry-switch">
              <Switch
                size="small"
                checked={retryEnabled === true}
                loading={optionsLoading}
                disabled={!chatOptions}
                onChange={setRetryEnabled}
              />
              <span className="chat-retry-switch__label">检索不到时改写重试</span>
              <Tooltip title={retryTip}>
                <InfoCircleOutlined className="chat-retry-switch__help" />
              </Tooltip>
            </div>
            <Select
              value={kbId || undefined}
              onChange={setKbId}
              placeholder="选择知识库"
              style={{ width: 200 }}
              options={kbs.map((kb) => ({ value: kb.id, label: kb.name }))}
            />
            <Tag className="chat-header__tag">知识库问答</Tag>
          </div>
        </header>

        <div className="chat-messages" ref={messagesRef}>
          {messages.length === 0 ? (
            <div className="chat-welcome">
              <div className="chat-welcome__icon">
                <RobotOutlined />
              </div>
              <div className="chat-welcome__title">你好，{username || '管理员'}</div>
              <p className="chat-welcome__desc">
                我可以基于知识库内容回答问题，并给出引用来源。
                <br />
                在下方输入你的问题开始对话。
              </p>
            </div>
          ) : (
            messages.map((item) => (
              <MessageBubble
                key={item.id}
                message={item}
                onRetry={handleRetry}
                onDismissRetry={handleDismissRetry}
              />
            ))
          )}
        </div>

        <footer className="chat-input-area">
          <div className="chat-input-box">
            <Input.TextArea
              ref={inputRef}
              className="chat-input"
              placeholder="输入你的问题，Enter 发送，Shift+Enter 换行..."
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
              autoSize={{ minRows: 1, maxRows: 5 }}
              disabled={isStreaming && messages.length === 0}
            />
            {isStreaming ? (
              <Button
                type="primary"
                danger
                className="chat-send-btn"
                icon={<StopOutlined />}
                onClick={stop}
              >
                停止
              </Button>
            ) : (
              <Button
                type="primary"
                className="chat-send-btn"
                icon={<SendOutlined />}
                disabled={!input.trim()}
                onClick={() => void handleSend()}
              />
            )}
          </div>
          <div className="chat-disclaimer">回答由 AI 生成，仅供参考。请核实重要信息。</div>
        </footer>
      </section>
    </div>
  )
}
