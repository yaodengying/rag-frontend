import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudUploadOutlined,
  CloseOutlined,
  DeleteOutlined,
  EyeOutlined,
  FileTextOutlined,
  InboxOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import {
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd'
import type { UploadProps } from 'antd'
import type { ColumnsType } from 'antd/es/table'

import {
  DOCUMENT_STATUS_TEXT,
  UPLOAD_ACCEPT,
  deleteDocument,
  getErrorMessage,
  isCanceled,
  isSupportedDocument,
  listDocuments,
  listKnowledgeBases,
  uploadDocument,
} from '../../api'
import type { DocumentStatus, KnowledgeBase, KnowledgeDocument } from '../../api'
import './documents.css'

/**
 * 页面 2：文档管理。
 *
 * 交互参照同工作区下的参考工程（ai-knowledge-rag 的 DocumentUpload 页）做了增强：
 *   1. **跨知识库聚合**：进入页面即并行拉取全部知识库的文档并打上库名，
 *      列表默认展示「全部知识库」，可按库筛选 —— 不必先选库才能看到东西。
 *   2. **上传目标与列表筛选解耦**：上传目标单独一个选择器；把筛选切到某个库时会顺带
 *      把它设为上传目标（"我在看这个库，多半也要往这里传"），但两者不互相绑定。
 *   3. **上传队列**：逐文件展示「排队中 → 上传中 → 解析中 → 完成/失败」，失败项可单独移除。
 *   4. **详情抽屉**：点「查看」打开抽屉看元数据，不再是占位提示。
 *   5. **删除二次确认改用 Modal**，明确写出"切片与索引会一并删除"。
 *   6. 上传白名单与体积在**前端先拦一道**（扩展名不支持直接拒，不白跑一个请求）。
 *
 * 与后端的取舍（保持既有结论，不引入假数据）：
 *   - 文档接口是 `GET /knowledge-bases/{kb_id}/documents`，**kb_id 是必填路径参数**，
 *     「全部知识库」因此是 N 个请求并行聚合，单库失败只让该库贡献空数组。
 *   - 列表接口不支持 status / keyword 过滤，筛选一律在前端本地做。
 *   - 后端**已有**「原地重试」接口 `POST /documents/{doc_id}/reprocess`
 *     （复用已落盘的原始文件，不产生新 doc_id），但**前端尚未接入**，
 *     所以失败行暂时没有「重试」按钮。接入时注意：该接口是同步的，
 *     大文件可能跑几十秒，按钮需要 loading 态并防止重复点击。
 *   - 后端没有文件体积字段 → 「大小」列不展示（`formatSize` 保留给上传队列用）。
 */

const TYPE_LABEL: Record<KnowledgeDocument['type'], string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  txt: 'TXT',
  md: 'MD',
  pptx: 'PPTX',
}

/** 表格行：在文档上附加所属知识库名（聚合视图必须能看出文档属于哪个库） */
interface DocRow extends KnowledgeDocument {
  kbName: string
}

/** 处理状态徽章：图标 + 颜色都按状态给，扫一眼就能区分 */
const STATUS_TAG: Record<DocumentStatus, { color: string; icon: ReactNode }> = {
  done: { color: 'success', icon: <CheckCircleOutlined /> },
  processing: { color: 'processing', icon: <LoadingOutlined /> },
  failed: { color: 'error', icon: <WarningOutlined /> },
  pending: { color: 'default', icon: <ClockCircleOutlined /> },
}

function StatusTag({ status }: { status: DocumentStatus }) {
  const config = STATUS_TAG[status]
  return (
    <Tag color={config.color} icon={config.icon}>
      {DOCUMENT_STATUS_TEXT[status]}
    </Tag>
  )
}

/** 上传队列里单条任务的生命周期 */
type UploadPhase = 'queued' | 'uploading' | 'processing' | 'done' | 'error'

interface UploadTask {
  id: string
  name: string
  size: number
  percent: number
  phase: UploadPhase
  error?: string
}

const PHASE_TAG: Record<UploadPhase, ReactNode> = {
  queued: <Tag icon={<ClockCircleOutlined />}>排队中</Tag>,
  uploading: <Tag color="processing" icon={<LoadingOutlined />}>上传中</Tag>,
  processing: <Tag color="processing" icon={<LoadingOutlined />}>解析中</Tag>,
  done: <Tag color="success" icon={<CheckCircleOutlined />}>完成</Tag>,
  error: <Tag color="error" icon={<WarningOutlined />}>失败</Tag>,
}

/** 队列里是否有还在跑的任务（决定「清空」是否可用） */
function isRunning(task: UploadTask) {
  return task.phase === 'queued' || task.phase === 'uploading' || task.phase === 'processing'
}

function formatSize(bytes: number): string {
  if (!bytes) {
    return '—'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export default function DocumentsPage() {
  const { message } = AntdApp.useApp()
  const [searchParams, setSearchParams] = useSearchParams()

  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [docs, setDocs] = useState<DocRow[]>([])
  /** 'all' 或某个知识库 id */
  const [kbFilter, setKbFilter] = useState(searchParams.get('kbId') ?? 'all')
  const [uploadKbId, setUploadKbId] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<DocumentStatus | ''>('')
  const [keyword, setKeyword] = useState('')
  const [drawerDoc, setDrawerDoc] = useState<DocRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DocRow | null>(null)
  /** 删除请求进行中：确认按钮转圈并挡住重复提交 */
  const [deleting, setDeleting] = useState(false)
  const [queue, setQueue] = useState<UploadTask[]>([])

  const kbOptions = useMemo(
    () => kbs.map((kb) => ({ value: kb.id, label: `${kb.name}（${kb.docCount} 个文档）` })),
    [kbs],
  )

  /* ------------------------------------------------------------------ *
   * 数据加载
   * ------------------------------------------------------------------ */

  const loadKbs = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const list = await listKnowledgeBases({ signal })
        if (signal?.aborted) {
          return []
        }
        // 内容没变就不换引用：setKbs 会触发文档重载，刷新时没必要白跑一轮
        setKbs((prev) => (isSameKbList(prev, list) ? prev : list))
        // 上传目标默认落在地址栏指定的那个库，否则取第一个
        setUploadKbId((current) => current || kbFilterForDefault(list))
        return list
      } catch (error) {
        if (!isCanceled(error)) {
          void message.error(getErrorMessage(error))
        }
        return []
      }
    },
    [message],
  )

  const loadDocs = useCallback(
    async (source: KnowledgeBase[], signal?: AbortSignal) => {
      if (source.length === 0) {
        setDocs([])
        return
      }
      // 「全部知识库」= 并行拉每个库；单库失败只让该库为空，不阻断其它库
      const targets = kbFilter === 'all' ? source : source.filter((kb) => kb.id === kbFilter)
      if (targets.length === 0) {
        setDocs([])
        return
      }

      setLoading(true)
      try {
        const groups = await Promise.all(
          targets.map(async (kb) => {
            try {
              const items = await listDocuments({ kbId: kb.id, signal })
              return { rows: items.map((doc) => ({ ...doc, kbName: kb.name })), failed: false }
            } catch (error) {
              // 主动取消（StrictMode 双挂载）不算失败，也不要打扰用户
              return { rows: [] as DocRow[], failed: !isCanceled(error), error }
            }
          }),
        )

        if (signal?.aborted) {
          return
        }
        setDocs(groups.flatMap((group) => group.rows))

        // 全军覆没说明多半是后端/鉴权问题，提示一次；只有部分库失败就静默（不打断浏览）
        const failures = groups.filter((group) => group.failed)
        if (failures.length === targets.length) {
          void message.error(getErrorMessage(failures[0]?.error))
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false)
        }
      }
    },
    [kbFilter, message],
  )

  // 知识库列表：进入页面拉一次即可，筛选变化不该重拉
  useEffect(() => {
    const controller = new AbortController()
    void loadKbs(controller.signal)
    return () => controller.abort()
  }, [loadKbs])

  // 文档：知识库列表就绪或筛选变化时重新聚合
  useEffect(() => {
    if (kbs.length === 0) {
      setDocs([])
      return
    }
    const controller = new AbortController()
    void loadDocs(kbs, controller.signal)
    return () => controller.abort()
  }, [kbs, loadDocs])

  // 筛选切到具体某个库时，把上传目标一并带过去（不反向同步：改上传目标不影响筛选）
  useEffect(() => {
    if (kbFilter !== 'all') {
      setUploadKbId(kbFilter)
    }
  }, [kbFilter])

  // 选中项同步到地址栏，便于分享/刷新后保持
  useEffect(() => {
    setSearchParams(kbFilter === 'all' ? {} : { kbId: kbFilter }, { replace: true })
  }, [kbFilter, setSearchParams])

  const refresh = useCallback(async () => {
    const list = await loadKbs()
    await loadDocs(list, undefined)
  }, [loadDocs, loadKbs])

  /* ------------------------------------------------------------------ *
   * 上传队列
   *
   * 逐文件顺序上传（后端入库本身也是串行，见 api/modules/documents.ts 的说明）。
   * antd 的 beforeUpload 对同批文件逐个同步调用，这里把它们放进 ref 队列，
   * 由一个"泵"顺序消费；用 ref 而不是 state 是为了避免闭包拿到旧队列。
   * ------------------------------------------------------------------ */

  const pendingRef = useRef<{ taskId: string; file: File; kbId: string }[]>([])
  const pumpingRef = useRef(false)

  const patchTask = useCallback((taskId: string, patch: Partial<UploadTask>) => {
    setQueue((prev) => prev.map((task) => (task.id === taskId ? { ...task, ...patch } : task)))
  }, [])

  const pump = useCallback(async () => {
    if (pumpingRef.current) {
      return
    }
    pumpingRef.current = true
    try {
      while (pendingRef.current.length > 0) {
        const next = pendingRef.current.shift()
        if (!next) {
          break
        }
        patchTask(next.taskId, { phase: 'uploading' })
        try {
          const doc = await uploadDocument(next.file, next.kbId, {
            onProgress: (percent) =>
              // 字节传完后请求仍在等后端索引，标成「解析中」更贴近真实状态
              patchTask(next.taskId, {
                percent,
                phase: percent >= 100 ? 'processing' : 'uploading',
              }),
          })
          if (doc.status === 'failed') {
            // 2xx 但流水线失败：原因在文档的 error 字段里
            patchTask(next.taskId, {
              phase: 'error',
              error: doc.error || '解析失败',
            })
          } else {
            patchTask(next.taskId, { percent: 100, phase: 'done' })
          }
        } catch (error) {
          patchTask(next.taskId, { phase: 'error', error: getErrorMessage(error) })
        }
      }
    } finally {
      pumpingRef.current = false
      // 队列跑完统一刷新一次：文档列表 + 知识库的文档计数
      window.setTimeout(() => void refresh(), 0)
    }
  }, [patchTask, refresh])

  const uploadProps: UploadProps = {
    multiple: true,
    showUploadList: false,
    accept: UPLOAD_ACCEPT,
    disabled: !uploadKbId,
    // 拦下 antd 的默认上传行为，统一走请求层的 uploadDocument
    beforeUpload: (file) => {
      if (!uploadKbId) {
        void message.warning('请先选择要上传到的知识库')
        return Upload.LIST_IGNORE
      }
      if (!isSupportedDocument(file.name)) {
        void message.error(`${file.name} 格式不支持，仅支持 PDF / Word / TXT / Markdown / PPTX`)
        return Upload.LIST_IGNORE
      }
      const taskId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      pendingRef.current.push({ taskId, file, kbId: uploadKbId })
      setQueue((prev) => [
        ...prev,
        {
          id: taskId,
          name: file.name,
          size: file.size,
          percent: 0,
          phase: 'queued',
        },
      ])
      void pump()
      return false
    },
  }

  async function handleDelete() {
    // 删除不可恢复：请求还在飞时忽略后续点击，避免重复提交
    if (!deleteTarget || deleting) {
      return
    }
    setDeleting(true)
    try {
      await deleteDocument(deleteTarget.id)
      void message.success('文档已删除')
      setDeleteTarget(null)
      if (drawerDoc?.id === deleteTarget.id) {
        setDrawerDoc(null)
      }
      setDocs((prev) => prev.filter((item) => item.id !== deleteTarget.id))
      // 顺带同步知识库的文档计数（列表里那份是本地删的，计数还没变）
      void loadKbs()
    } catch (error) {
      void message.error(getErrorMessage(error))
    } finally {
      setDeleting(false)
    }
  }

  /* ------------------------------------------------------------------ *
   * 表格
   * ------------------------------------------------------------------ */

  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase()
    return docs.filter((doc) => {
      if (status && doc.status !== status) {
        return false
      }
      if (text && !doc.filename.toLowerCase().includes(text)) {
        return false
      }
      return true
    })
  }, [docs, status, keyword])

  const columns: ColumnsType<DocRow> = [
    {
      title: '文件名',
      dataIndex: 'filename',
      ellipsis: true,
      render: (value: string, record) => (
        <span className="doc-filename">
          <FileTextOutlined />
          <span className="doc-filename__text">{value}</span>
          <Tag className="doc-type-tag">{TYPE_LABEL[record.type]}</Tag>
        </span>
      ),
    },
    { title: '知识库', dataIndex: 'kbName', width: 160, ellipsis: true },
    { title: '上传时间', dataIndex: 'uploadedAt', width: 180 },
    {
      title: '处理状态',
      dataIndex: 'status',
      width: 120,
      render: (value: DocumentStatus, record) => (
        <span className="doc-status">
          <StatusTag status={value} />
          {record.error && <span className="doc-status__error">{record.error}</span>}
        </span>
      ),
    },
    { title: '切片数', dataIndex: 'chunkCount', width: 90, align: 'right' },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      align: 'right',
      render: (_, record) => (
        <div className="doc-actions">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setDrawerDoc(record)}>
            查看
          </Button>
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => setDeleteTarget(record)}
          />
        </div>
      ),
    },
  ]

  const hasRunning = queue.some(isRunning)

  return (
    <div className="doc-page">
      {/* ---------------- 上传区 ---------------- */}
      <Card className="doc-upload-card" styles={{ body: { padding: '18px 20px 20px' } }}>
        <div className="doc-upload-bar">
          <span className="doc-upload-bar__label">上传目标</span>
          <Select
            className="doc-kb-select"
            placeholder="选择知识库"
            value={uploadKbId || undefined}
            onChange={setUploadKbId}
            options={kbOptions}
          />
          {!uploadKbId && (
            <Typography.Text type="warning" className="doc-upload-bar__warn">
              还没有知识库，请先到「知识库管理」创建
            </Typography.Text>
          )}
        </div>

        <Upload.Dragger {...uploadProps} className="doc-upload">
          <div className="doc-upload__icon">
            <CloudUploadOutlined />
          </div>
          <div className="doc-upload__title">
            {uploadKbId ? '拖拽文件到此处，或点击选择' : '请先选择上传目标知识库'}
          </div>
          <div className="doc-upload__hint">
            支持 PDF、Word、TXT、Markdown、PPTX；可批量选择，逐个上传并即时反馈结果
          </div>
          <Button
            type="primary"
            icon={<InboxOutlined />}
            disabled={!uploadKbId}
            className="doc-upload__btn"
          >
            选择文件
          </Button>
        </Upload.Dragger>

        {queue.length > 0 && (
          <div className="doc-queue">
            <div className="doc-queue__head">
              <span className="doc-queue__title">
                上传队列
                <small>{hasRunning ? `${queue.length} 个文件处理中` : `${queue.length} 个文件已结束`}</small>
              </span>
              <Button
                type="link"
                size="small"
                // 还有任务在跑时禁止清空，否则进度会凭空消失
                disabled={hasRunning}
                onClick={() => setQueue([])}
              >
                清空记录
              </Button>
            </div>
            <div className="doc-queue__list">
              {queue.map((task) => (
                <div key={task.id} className={`doc-queue__item doc-queue__item--${task.phase}`}>
                  <FileTextOutlined className="doc-queue__icon" />
                  <div className="doc-queue__meta">
                    <div className="doc-queue__top">
                      <span className="doc-queue__name" title={task.name}>
                        {task.name}
                      </span>
                      <span className="doc-queue__percent">{Math.round(task.percent)}%</span>
                    </div>
                    <Progress
                      percent={Math.round(task.percent)}
                      showInfo={false}
                      size="small"
                      status={task.phase === 'error' ? 'exception' : 'normal'}
                    />
                    <div className="doc-queue__bottom">
                      <span className="doc-queue__size">{formatSize(task.size)}</span>
                      {PHASE_TAG[task.phase]}
                      {task.error && <span className="doc-queue__error">{task.error}</span>}
                    </div>
                  </div>
                  {task.phase === 'error' && (
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      aria-label="移除该记录"
                      onClick={() => setQueue((prev) => prev.filter((item) => item.id !== task.id))}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* ---------------- 文档表格 ---------------- */}
      <Card
        className="doc-table-card"
        styles={{ body: { padding: '8px 24px 20px' } }}
        title={
          <span className="doc-table-title">
            文档管理
            <small>
              共 {filtered.length} 个文档
              {kbFilter === 'all' && kbs.length > 1 ? `，来自 ${kbs.length} 个知识库` : ''}
            </small>
          </span>
        }
        extra={
          <div className="doc-table-toolbar">
            <Select
              className="doc-kb-select"
              value={kbFilter}
              onChange={setKbFilter}
              options={[{ value: 'all', label: '全部知识库' }, ...kbOptions]}
            />
            <Select<DocumentStatus | ''>
              value={status}
              onChange={setStatus}
              className="doc-status-select"
              options={[
                { value: '', label: '全部状态' },
                { value: 'done', label: '已完成' },
                { value: 'processing', label: '解析中' },
                { value: 'pending', label: '排队中' },
                { value: 'failed', label: '失败' },
              ]}
            />
            <Input
              className="doc-search"
              placeholder="搜索文档..."
              prefix={<SearchOutlined className="doc-search-icon" />}
              allowClear
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void refresh()}
              title="刷新列表"
            />
          </div>
        }
      >
        <Table<DocRow>
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50],
            showTotal: (total) => `共 ${total} 条`,
          }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  kbs.length === 0
                    ? '还没有知识库，创建后即可上传文档'
                    : docs.length === 0
                      ? '该知识库下暂无文档，拖拽文件到上方区域即可上传'
                      : '没有符合筛选条件的文档'
                }
              />
            ),
          }}
        />
      </Card>

      {/* ---------------- 详情抽屉 ---------------- */}
      <Drawer
        title={drawerDoc?.filename}
        open={Boolean(drawerDoc)}
        onClose={() => setDrawerDoc(null)}
        width={460}
        destroyOnHidden
      >
        {drawerDoc && (
          <div className="doc-drawer">
            <Space wrap className="doc-drawer__meta">
              <StatusTag status={drawerDoc.status} />
              <Tag className="doc-type-tag">{TYPE_LABEL[drawerDoc.type]}</Tag>
              <Typography.Text type="secondary">
                {drawerDoc.chunkCount} 个切片
              </Typography.Text>
            </Space>

            <div className="doc-drawer__field">
              <span className="doc-drawer__label">所属知识库</span>
              <span>{drawerDoc.kbName || '—'}</span>
            </div>
            <div className="doc-drawer__field">
              <span className="doc-drawer__label">上传时间</span>
              <span>{drawerDoc.uploadedAt || '—'}</span>
            </div>
            <div className="doc-drawer__field">
              <span className="doc-drawer__label">文档 ID</span>
              <span className="doc-drawer__mono">{drawerDoc.id}</span>
            </div>

            {drawerDoc.error && (
              <Typography.Paragraph type="danger" className="doc-drawer__error">
                解析失败：{drawerDoc.error}
              </Typography.Paragraph>
            )}

            <Typography.Title level={5} className="doc-drawer__section">
              切片信息
            </Typography.Title>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                drawerDoc.chunkCount > 0
                  ? `已生成 ${drawerDoc.chunkCount} 个切片（切片全文预览未开放）`
                  : '暂无可预览的切片'
              }
            />
          </div>
        )}
      </Drawer>

      {/* ---------------- 删除确认 ---------------- */}
      <Modal
        title="确认删除文档？"
        open={Boolean(deleteTarget)}
        onOk={() => void handleDelete()}
        onCancel={() => {
          // 删除进行中不允许关闭，避免用户以为没删
          if (!deleting) {
            setDeleteTarget(null)
          }
        }}
        okText="确认删除"
        okButtonProps={{ danger: true, disabled: deleting }}
        cancelButtonProps={{ disabled: deleting }}
        confirmLoading={deleting}
        closable={!deleting}
        cancelText="取消"
        destroyOnHidden
      >
        <Typography.Paragraph>
          删除「{deleteTarget?.filename}」会同时移除该文档的切片与向量索引，操作不可恢复。
        </Typography.Paragraph>
      </Modal>
    </div>
  )
}

/** 上传目标的默认值：地址栏指定了具体库就用它，否则用第一个库 */
function kbFilterForDefault(list: KnowledgeBase[]): string {
  const fromUrl = new URLSearchParams(window.location.search).get('kbId')
  if (fromUrl && list.some((kb) => kb.id === fromUrl)) {
    return fromUrl
  }
  return list[0]?.id ?? ''
}

/** 知识库列表是否等价。用于避免 setState 产生新数组引用而触发多余的文档重载。 */
function isSameKbList(prev: KnowledgeBase[], next: KnowledgeBase[]): boolean {
  if (prev.length !== next.length) {
    return false
  }
  return prev.every((kb, index) => {
    const other = next[index]
    return kb.id === other.id && kb.name === other.name && kb.docCount === other.docCount
  })
}
