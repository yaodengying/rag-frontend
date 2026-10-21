import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  AppstoreOutlined,
  CalendarOutlined,
  DatabaseOutlined,
  EllipsisOutlined,
  FileTextOutlined,
  MessageOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import {
  App as AntdApp,
  Button,
  Card,
  Dropdown,
  Form,
  Input,
  Modal,
  Table,
  Tooltip,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'

import {
  computeKbStats,
  createKnowledgeBase,
  deleteKnowledgeBase,
  getErrorMessage,
  isCanceled,
  listConversations,
  listDocuments,
  listKnowledgeBases,
  summarizeChatStats,
  updateKnowledgeBase,
} from '../../api'
import type { ChatStats, DocumentStatus, KbStats, KnowledgeBase } from '../../api'
import './knowledge-base.css'

/**
 * 页面 1：知识库管理（对齐产品原型的信息架构）。
 *
 * 原型要求 4 张统计卡 + 表格含「切片数 / 引用次数 / 状态」。后端
 * KnowledgeBaseOut 只有 { id, name, description, doc_count, created_at }，
 * 这些字段在前端用**真实数据**补齐，绝不造假：
 *   - 切片数：并行拉取各库文档列表，聚合每份文档的 chunk_count；
 *   - 状态：由文档状态派生（空库 / 处理中 / 部分失败 / 就绪），不是后端不存在的
 *     「启用/归档」概念；
 *   - 引用次数：服务端会话存储里每条回答携带的引用条数（citation_count），
 *     会话落库时带了 kbId，可按库分桶；无 kbId 的会话只计入总数。
 *
 * 两条实现上要留意的取舍：
 *   - **切片数只在"全部库的明细都取成功"时才给真值**，否则归 0（见 `stats` 的
 *     useMemo）。局部求和会得出一个看似正常、实则偏低的数，用户没有任何线索
 *     能察觉它错了；归 0 配合加载态至少能被读成"还没算出来"。
 *   - **删除是级联的**：后端删库会连带删该库的文档与会话（知识库是它们的
 *     拥有者），所以二次确认里要写明"文档也会一起没"，别只说删个名字。
 *
 * 列表按账号隔离：接口只返回当前登录账号名下的库，前端不做额外过滤——
 * 前端过滤从来不是安全边界。
 */

interface KbFormValues {
  name: string
  description?: string
}

/** 单个知识库的文档明细聚合结果 */
interface KbDocDetail {
  /** 全库切片总数（各文档 chunk_count 之和） */
  chunks: number
  /** 各文档状态，用于派生库级状态 */
  statuses: DocumentStatus[]
  /** 文档列表请求本身失败（区别于「没有文档」） */
  failed: boolean
}

/** 库级派生状态：全部由真实文档数据推导 */
type KbDerivedStatus = 'ready' | 'processing' | 'failed' | 'empty' | 'unknown'

const DERIVED_STATUS: Record<KbDerivedStatus, { text: string; className: string }> = {
  ready: { text: '就绪', className: 'kb-status--ready' },
  processing: { text: '处理中', className: 'kb-status--processing' },
  failed: { text: '部分失败', className: 'kb-status--failed' },
  empty: { text: '空库', className: 'kb-status--empty' },
  unknown: { text: '—', className: 'kb-status--unknown' },
}

function deriveStatus(kb: KnowledgeBase, detail?: KbDocDetail): KbDerivedStatus {
  if (!detail || detail.failed) {
    return 'unknown'
  }
  if (kb.docCount === 0 && detail.statuses.length === 0) {
    return 'empty'
  }
  if (detail.statuses.some((status) => status === 'pending' || status === 'processing')) {
    return 'processing'
  }
  if (detail.statuses.some((status) => status === 'failed')) {
    return 'failed'
  }
  return 'ready'
}

export default function KnowledgeBasePage() {
  const navigate = useNavigate()
  const { message, modal } = AntdApp.useApp()

  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [details, setDetails] = useState<Record<string, KbDocDetail>>({})
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  /** 正在删除的知识库 id：冻结该行操作并挡住重复提交 */
  const [deletingId, setDeletingId] = useState<string | null>(null)
  /**
   * 与 deletingId 同步的重入开关。
   * modal.confirm 的 onOk 闭包在弹窗创建时就固定了，读不到最新的 state，
   * 所以真正的防重复判断必须走 ref。
   */
  const deletingRef = useRef(false)
  /** 有值表示编辑，为空表示新建 */
  const [editing, setEditing] = useState<KnowledgeBase | null>(null)
  const [form] = Form.useForm<KbFormValues>()

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      try {
        const list = await listKnowledgeBases({ signal })
        setKbs(list)
      } catch (error) {
        // StrictMode 双挂载会中断第一批请求，取消不算错误
        if (!isCanceled(error)) {
          void message.error(getErrorMessage(error))
        }
      } finally {
        setLoading(false)
      }
    },
    [message],
  )

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  /**
   * 文档明细并行拉取：切片数与派生状态的数据源。
   * allSettled 让单个库的失败不影响其余库（失败的库显示「—」）。
   */
  useEffect(() => {
    if (kbs.length === 0) {
      return
    }
    const controller = new AbortController()
    void (async () => {
      const settled = await Promise.allSettled(
        kbs.map(async (kb) => ({
          kbId: kb.id,
          docs: await listDocuments({ kbId: kb.id, signal: controller.signal }),
        })),
      )
      if (controller.signal.aborted) {
        return
      }
      setDetails((prev) => {
        const next = { ...prev }
        settled.forEach((result, index) => {
          const kbId = kbs[index].id
          if (result.status === 'fulfilled') {
            next[kbId] = {
              chunks: result.value.docs.reduce((sum, doc) => sum + doc.chunkCount, 0),
              statuses: result.value.docs.map((doc) => doc.status),
              failed: false,
            }
          } else if (!(kbId in next)) {
            next[kbId] = { chunks: 0, statuses: [], failed: true }
          }
        })
        return next
      })
    })()
    return () => controller.abort()
  }, [kbs])

  /**
   * 问答引用统计（数据源：服务端会话存储的列表接口）。
   * 挂载时拉一次；拉取失败（如 REDIS_URL 未配置、后端 503）时保持全 0——
   * 统计是锦上添花，不该把整个管理页拖出报错弹窗。
   */
  const [chatStats, setChatStats] = useState<ChatStats>({
    conversationCount: 0,
    citationTotal: 0,
    citationsByKb: {},
  })
  useEffect(() => {
    const controller = new AbortController()
    listConversations()
      .then((summaries) => setChatStats(summarizeChatStats(summaries)))
      .catch(() => {
        /* 静默降级：统计卡显示 0，不打扰主流程 */
      })
    return () => controller.abort()
  }, [])

  /** 原型四卡：总数 / 文档 / 切片 / 累计引用，全部来自真实数据聚合 */
  const stats: KbStats & { readyKbs: number | null } = useMemo(() => {
    const base = computeKbStats(kbs)
    const enriched = kbs.map((kb) => deriveStatus(kb, details[kb.id]))
    const readyKbs = kbs.every((kb) => details[kb.id] && !details[kb.id].failed)
      ? enriched.filter((status) => status === 'ready').length
      : null
    const chunkTotal = kbs.reduce((sum, kb) => sum + (details[kb.id]?.chunks ?? 0), 0)
    return {
      ...base,
      // 明细不全时归 0 而不是"求和已有的那部分"：
      // 局部和会给出一个看似正常、实则偏低的数，用户没有任何线索能察觉它错了。
      // 归 0 配合加载态（`loading ? null : ...`）至少能被读成"还没算出来"。
      chunkTotal: kbs.every((kb) => details[kb.id] && !details[kb.id].failed) ? chunkTotal : 0,
      quoteTotal: chatStats.citationTotal,
      readyKbs,
    }
  }, [kbs, details, chatStats])

  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase()
    if (!text) {
      return kbs
    }
    return kbs.filter(
      (kb) => kb.name.toLowerCase().includes(text) || kb.description.toLowerCase().includes(text),
    )
  }, [kbs, keyword])

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setFormOpen(true)
  }

  function openEdit(kb: KnowledgeBase) {
    setEditing(kb)
    form.setFieldsValue({ name: kb.name, description: kb.description })
    setFormOpen(true)
  }

  async function handleSubmit(values: KbFormValues) {
    setSubmitting(true)
    try {
      const payload = { name: values.name.trim(), description: values.description?.trim() }
      if (editing) {
        await updateKnowledgeBase(editing.id, payload)
        void message.success('知识库已更新')
      } else {
        await createKnowledgeBase(payload)
        void message.success('知识库已创建')
      }
      setFormOpen(false)
      setEditing(null)
      form.resetFields()
      await refresh()
    } catch (error) {
      void message.error(getErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(kb: KnowledgeBase) {
    // 删除不可恢复：请求还在飞时忽略后续点击，避免重复提交
    if (deletingRef.current) {
      return
    }
    deletingRef.current = true
    setDeletingId(kb.id)
    try {
      await deleteKnowledgeBase(kb.id)
      void message.success('已删除')
      await refresh()
    } catch (error) {
      void message.error(getErrorMessage(error))
    } finally {
      deletingRef.current = false
      setDeletingId(null)
    }
  }

  function confirmDelete(kb: KnowledgeBase) {
    modal.confirm({
      title: `确认删除「${kb.name}」？`,
      content: `该知识库下的 ${kb.docCount} 个文档、其切片向量与上传文件都会一并删除，且不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => handleDelete(kb),
    })
  }

  /** 状态徽标：由文档状态派生 */
  function statusOf(kb: KnowledgeBase) {
    return DERIVED_STATUS[deriveStatus(kb, details[kb.id])]
  }

  const columns: ColumnsType<KnowledgeBase> = [
    {
      title: '名称',
      dataIndex: 'name',
      ellipsis: true,
      width: 200,
      render: (value: string, record) => (
        <Button
          type="link"
          className="kb-name-link"
          onClick={() => navigate(`/documents?kbId=${encodeURIComponent(record.id)}`)}
        >
          {value}
        </Button>
      ),
    },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    {
      title: '文档数',
      dataIndex: 'docCount',
      width: 100,
      sorter: (a, b) => a.docCount - b.docCount,
    },
    {
      title: '切片数',
      key: 'chunks',
      width: 100,
      render: (_, record) => {
        const detail = details[record.id]
        if (!detail || detail.failed) {
          return <span className="kb-cell-muted">—</span>
        }
        return detail.chunks
      },
      sorter: (a, b) => (details[a.id]?.chunks ?? -1) - (details[b.id]?.chunks ?? -1),
    },
    {
      title: (
        <Tooltip
          title="统计本地问答记录中每条回答携带的引用条数；清理浏览器数据后会归零重计"
        >
          引用次数
        </Tooltip>
      ),
      key: 'citations',
      width: 110,
      render: (_, record) => {
        const count = chatStats.citationsByKb[record.id]
        if (count === undefined) {
          return (
            <Tooltip title="该库暂无本地问答引用记录">
              <span className="kb-cell-muted">—</span>
            </Tooltip>
          )
        }
        return count
      },
      sorter: (a, b) => (chatStats.citationsByKb[a.id] ?? -1) - (chatStats.citationsByKb[b.id] ?? -1),
    },
    {
      title: (
        <span className="kb-col-time">
          <CalendarOutlined /> 创建时间
        </span>
      ),
      dataIndex: 'createdAt',
      width: 200,
      render: (value: string) => (
        <span className="kb-time">
          <CalendarOutlined /> {value || '—'}
        </span>
      ),
      sorter: (a, b) => (a.createdAt < b.createdAt ? -1 : 1),
    },
    {
      title: '状态',
      key: 'status',
      width: 110,
      render: (_, record) => {
        const status = statusOf(record)
        return <span className={`kb-status ${status.className}`}>{status.text}</span>
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 70,
      align: 'center',
      render: (_, record) => {
        const deleting = deletingId === record.id
        /** 任一行动在删除中都冻结整行操作，避免并发触发 */
        const frozen = deletingId !== null
        return (
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'view',
                  label: '查看文档',
                  disabled: frozen,
                  onClick: () =>
                    navigate(`/documents?kbId=${encodeURIComponent(record.id)}`),
                },
                {
                  key: 'edit',
                  label: '编辑',
                  disabled: frozen,
                  onClick: () => openEdit(record),
                },
                { type: 'divider' },
                {
                  key: 'delete',
                  label: deleting ? '删除中…' : '删除',
                  danger: true,
                  disabled: frozen,
                  onClick: () => confirmDelete(record),
                },
              ],
            }}
          >
            <Button
              type="text"
              icon={<EllipsisOutlined />}
              aria-label="更多操作"
              loading={deleting}
              disabled={frozen && !deleting}
            />
          </Dropdown>
        )
      },
    },
  ]

  const statCards = [
    {
      label: '知识库总数',
      value: stats.kbTotal,
      icon: <DatabaseOutlined />,
      hint: stats.readyKbs === null ? '统计中…' : `就绪 ${stats.readyKbs} 个`,
    },
    {
      label: '文档总数',
      value: stats.docTotal,
      icon: <FileTextOutlined />,
      hint: '覆盖全部知识库',
    },
    {
      label: '切片总数',
      value: loading ? null : stats.chunkTotal,
      icon: <AppstoreOutlined />,
      hint: '向量化片段',
    },
    {
      label: '累计引用',
      value: stats.quoteTotal,
      icon: <MessageOutlined />,
      hint: '问答引用次数',
    },
  ]

  return (
    <div className="kb-page">
      <div className="kb-stats">
        {statCards.map((card) => (
          <Card key={card.label} className="kb-stat-card" styles={{ body: { padding: '18px 20px' } }}>
            <div className="kb-stat-card__label">{card.label}</div>
            <div className="kb-stat-card__value">
              {card.value ?? '—'}
            </div>
            <div className="kb-stat-card__hint">
              <span className="kb-stat-card__hint-icon">{card.icon}</span>
              {card.hint}
            </div>
          </Card>
        ))}
      </div>

      <Card
        className="kb-table-card"
        styles={{ body: { padding: '20px 24px' } }}
        title="知识库列表"
        extra={
          <div className="kb-table-toolbar">
            <Input
              className="kb-search"
              placeholder="搜索知识库..."
              prefix={<SearchOutlined className="kb-search-icon" />}
              allowClear
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建知识库
            </Button>
          </div>
        }
      >
        <Table<KnowledgeBase>
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          pagination={{
            pageSize: 10,
            hideOnSinglePage: true,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 个知识库`,
          }}
          locale={{ emptyText: '暂无知识库，点击右上角「新建知识库」开始' }}
        />
      </Card>

      <Modal
        title={editing ? '编辑知识库' : '新建知识库'}
        open={formOpen}
        okText={editing ? '保存' : '创建'}
        cancelText="取消"
        confirmLoading={submitting}
        destroyOnHidden
        onOk={() => form.submit()}
        onCancel={() => {
          setFormOpen(false)
          setEditing(null)
        }}
      >
        <Form<KbFormValues> form={form} layout="vertical" requiredMark={false} onFinish={handleSubmit}>
          <Form.Item
            name="name"
            label="名称"
            rules={[
              { required: true, message: '请输入知识库名称' },
              { max: 100, message: '名称不能超过 100 个字符' },
            ]}
          >
            <Input placeholder="例如：产品帮助中心" autoFocus />
          </Form.Item>
          <Form.Item
            name="description"
            label="描述"
            rules={[{ max: 500, message: '描述不能超过 500 个字符' }]}
          >
            <Input.TextArea
              placeholder="简要说明该知识库的用途"
              autoSize={{ minRows: 3, maxRows: 5 }}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
