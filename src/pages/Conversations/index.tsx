import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  ArrowRightOutlined,
  ClockCircleOutlined,
  MessageOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { App as AntdApp, Button, Card, Input, Spin } from 'antd'

import { deleteConversation, getErrorMessage, listConversations } from '../../api'
import type { ConversationSummary } from '../../api'
import './conversations.css'

/**
 * 页面 4：对话历史。
 * 结构对齐原型：标题卡（搜索 / 新建对话）+ 按日期分组的会话卡片。
 */

/** 把 2024-01-15 10:15:00 归一化为日期键与展示文案 */
function groupByDate(conversations: ConversationSummary[]): { date: string; items: ConversationSummary[] }[] {
  const groups = new Map<string, ConversationSummary[]>()
  for (const item of conversations) {
    const date = item.updatedAt.slice(0, 10) || '未知日期'
    const bucket = groups.get(date)
    if (bucket) {
      bucket.push(item)
    } else {
      groups.set(date, [item])
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([date, items]) => ({ date, items }))
}

export default function ConversationsPage() {
  const navigate = useNavigate()
  const { message: notify, modal } = AntdApp.useApp()

  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  /** 正在删除的会话 id：卡片按钮转圈并挡住重复提交 */
  const [deletingId, setDeletingId] = useState<string | null>(null)
  /**
   * 与 deletingId 同步的重入开关。
   * modal.confirm 的 onOk 闭包在弹窗创建时就固定了，读不到最新的 state，
   * 所以真正的防重复判断必须走 ref。
   */
  const deletingRef = useRef(false)

  const load = useCallback(
    async (keyword?: string) => {
      setLoading(true)
      try {
        const list = await listConversations({ keyword: keyword || undefined })
        setConversations(list)
      } catch (error) {
        void notify.error(getErrorMessage(error))
      } finally {
        setLoading(false)
      }
    },
    [notify],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => void load(keyword.trim() || undefined), 250)
    return () => window.clearTimeout(timer)
  }, [keyword, load])

  const groups = useMemo(() => groupByDate(conversations), [conversations])

  function openConversation(id: string) {
    navigate(`/chat?id=${encodeURIComponent(id)}`)
  }

  function confirmDelete(item: ConversationSummary) {
    modal.confirm({
      title: `确认删除会话「${item.title}」？`,
      content: '该会话的消息记录与引用来源将一并删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      // 返回 Promise：antd 会自动给确认按钮加 loading，加载期间按钮不可再点
      onOk: async () => {
        // 删除不可恢复：请求还在飞时忽略后续触发，避免重复提交
        if (deletingRef.current) {
          return
        }
        deletingRef.current = true
        setDeletingId(item.id)
        try {
          await deleteConversation(item.id)
          void notify.success('会话已删除')
          setConversations((prev) => prev.filter((conv) => conv.id !== item.id))
        } catch (error) {
          void notify.error(getErrorMessage(error))
        } finally {
          deletingRef.current = false
          setDeletingId(null)
        }
      },
    })
  }

  return (
    <div className="conv-page">
      <Card className="conv-head-card" styles={{ body: { padding: '18px 24px' } }}>
        <div className="conv-head">
          <div>
            <h1 className="conv-title">对话历史</h1>
            <p className="conv-subtitle">共 {conversations.length} 个历史会话</p>
          </div>
          <div className="conv-head__actions">
            <Input
              className="conv-search"
              placeholder="搜索会话标题..."
              prefix={<SearchOutlined className="conv-search-icon" />}
              allowClear
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/chat')}>
              新建对话
            </Button>
          </div>
        </div>
      </Card>

      {loading ? (
        <div className="conv-loading">
          <Spin />
        </div>
      ) : conversations.length === 0 ? (
        <Card className="conv-empty-card">
          <div className="conv-empty">没有找到匹配的会话</div>
        </Card>
      ) : (
        groups.map((group) => (
          <section key={group.date} className="conv-group">
            <div className="conv-group__date">
              <ClockCircleOutlined /> {group.date}
            </div>
            <div className="conv-group__cards">
              {group.items.map((item) => (
                <Card
                  key={item.id}
                  className="conv-card"
                  styles={{ body: { padding: '16px 18px' } }}
                  onClick={() => openConversation(item.id)}
                >
                  <div className="conv-card__head">
                    <span className="conv-card__icon">
                      <MessageOutlined />
                    </span>
                    <span className="conv-card__title">{item.title}</span>
                  </div>
                  <div className="conv-card__desc">查看完整对话记录与引用来源</div>
                  <div className="conv-card__footer">
                    <span className="conv-card__count">{item.messageCount} 条消息</span>
                    <span className="conv-card__more">
                      查看详情 <ArrowRightOutlined />
                    </span>
                  </div>
                  <Button
                    type="text"
                    size="small"
                    danger
                    className="conv-card__delete"
                    loading={deletingId === item.id}
                    disabled={deletingId !== null && deletingId !== item.id}
                    onClick={(event) => {
                      event.stopPropagation()
                      confirmDelete(item)
                    }}
                  >
                    删除
                  </Button>
                </Card>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
