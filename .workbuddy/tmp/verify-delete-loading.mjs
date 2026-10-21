// 删除按钮 loading 与防重复提交验证（Chrome headless + CDP）
// 场景 A：文档页——真实上传一个测试文档，再删除它（拦截并延迟 DELETE 请求，以便采样 loading）
// 场景 B：知识库页——新建临时知识库，再删除它
// 场景 C：对话历史页——本地会话删除（本地同步操作，只验证功能与数据落盘）
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9338
const APP = 'http://127.0.0.1:5180'
const OUT = 'H:/work/rag-frontend/.workbuddy/shots'
const UPLOAD_FILE = 'H:/work/rag-frontend/.workbuddy/tmp/delete-loading-sample.txt'
const TEMP_KB = '删除loading临时库'

mkdirSync(OUT, { recursive: true })
writeFileSync(
  UPLOAD_FILE,
  '删除按钮 loading 与防重复提交的验证文档。\n' + '这里是一段用于入库的检索内容，内容本身并不重要。\n'.repeat(20),
  'utf8',
)

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    '--proxy-server=direct://',
    '--proxy-bypass-list=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    '--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/chrome-rag-delete',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForCdp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return
    } catch {
      /* 等待 */
    }
    await sleep(250)
  }
  throw new Error('CDP 未就绪')
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.seq = 0
    this.waiters = new Map()
    this.errors = []
    this.requests = []
    /** DELETE 请求的人为延迟（毫秒），用于把「删除中」这个瞬间拉长以便采样 */
    this.fetchDelay = 0
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('ws 失败')))
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description ?? '')
      }
      if (msg.method === 'Network.requestWillBeSent') {
        this.requests.push({ method: msg.params.request.method, url: msg.params.request.url })
      }
      // 拦截请求：DELETE 按 fetchDelay 延迟放行，其余立即放行
      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, request } = msg.params
        const delay = request.method === 'DELETE' ? this.fetchDelay : 0
        setTimeout(() => {
          this.send('Fetch.continueRequest', { requestId }).catch(() => {})
        }, delay)
      }
      if (msg.id && this.waiters.has(msg.id)) {
        const { resolve, reject } = this.waiters.get(msg.id)
        this.waiters.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.waiters.has(id)) {
          this.waiters.delete(id)
          reject(new Error('CDP 超时: ' + method))
        }
      }, 120000)
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description ?? '未知'))
    }
    return r.result?.value
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
  }

  /** 统计 DELETE 请求条数（可按 URL 片段过滤） */
  deleteCount(fragment = '') {
    return this.requests.filter((r) => r.method === 'DELETE' && r.url.includes(fragment)).length
  }
}

async function waitFor(cdp, expression, label, timeout = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.evaluate(`!!(${expression})`)) return
    await sleep(300)
  }
  throw new Error(`等待超时（${label}）: ${expression}`)
}

/**
 * 用 CDP 真实鼠标事件按元素中心坐标点击。
 * 合成事件（dispatchEvent）在 rc-menu 这类会因 mousedown 重渲染的组件上会失效，
 * 必须走真实输入通道。
 */
async function realClick(cdp, expr) {
  const point = await cdp.evaluate(`(() => {
    const el = ${expr}
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!point) throw new Error('找不到可点击元素: ' + expr)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(300)
}

/**
 * 弹窗按钮区选择器：受控 <Modal> 用 .ant-modal-footer，
 * 而 modal.confirm 用的是 .ant-modal-confirm-btns（antd 两套结构不同）。
 */
const BTNS_BOX = `document.querySelector('.ant-modal-footer, .ant-modal-confirm-btns')`
const OK_BTN = `document.querySelector('.ant-modal-footer button.ant-btn-primary, .ant-modal-confirm-btns button.ant-btn-primary')`
const CANCEL_BTN = `document.querySelector('.ant-modal-footer button:not(.ant-btn-primary), .ant-modal-confirm-btns button:not(.ant-btn-primary)')`

/** 读取确认弹窗里各按钮的状态 */
const modalBtnExpr = `(() => {
  const ok = ${OK_BTN}
  const cancel = ${CANCEL_BTN}
  return {
    okClass: ok?.className ?? null,
    okDisabled: !!ok?.disabled,
    okText: ok?.innerText.replace(/\\s+/g, '') ?? null,
    cancelDisabled: !!cancel?.disabled,
    closeBtnExists: !!document.querySelector('.ant-modal-close'),
  }
})()`

/** 强制派发点击（绕过 disabled 元素的默认行为，用于验证 JS 重入守卫） */
const forceClickOkExpr = `(() => {
  const ok = ${OK_BTN}
  if (!ok) return false
  ok.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  return true
})()`

try {
  await waitForCdp()
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('DOM.enable')
  await cdp.send('Network.enable')
  // 只拦截文档与知识库相关请求，避免拖慢整页资源加载
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/documents/*' }, { urlPattern: '*/knowledge-bases/*' }],
  })

  // ---------- 登录 ----------
  await cdp.send('Page.navigate', { url: `${APP}/login` })
  await sleep(1500)
  await cdp.evaluate(`window.localStorage.clear(); window.sessionStorage.clear(); true`)
  await cdp.send('Page.navigate', { url: `${APP}/login` })
  await waitFor(cdp, `document.querySelector('#username')`, '登录表单')
  await cdp.evaluate(`(() => {
    const setValue = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setValue(document.querySelector('#username'), 'demo')
    setValue(document.querySelector('#password'), 'demo123456')
    return true
  })()`)
  await cdp.evaluate(`document.querySelector('button[type=submit]').click(); true`)
  await waitFor(cdp, `location.pathname !== '/login'`, '登录跳转')
  console.log('✅ 登录成功\n')

  /* ================================================================
   * 场景 A：文档页删除
   * ================================================================ */
  console.log('=== 场景 A：文档页删除 ===')
  await cdp.send('Page.navigate', { url: `${APP}/documents` })
  await waitFor(cdp, `document.querySelector('.doc-table-card .ant-table-tbody tr.ant-table-row')`, '文档表格', 90000)
  await sleep(1500)

  const doc = await cdp.send('DOM.getDocument', { depth: -1 })
  const inputNode = await cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '.doc-upload input[type=file]',
  })
  if (!inputNode.nodeId) throw new Error('没找到上传的 file input')
  await cdp.send('DOM.setFileInputFiles', { files: [UPLOAD_FILE], nodeId: inputNode.nodeId })
  await waitFor(cdp, `document.querySelector('.doc-queue__item--done')`, '上传完成', 180000)
  await waitFor(
    cdp,
    `Array.from(document.querySelectorAll('.doc-table-card .ant-table-tbody tr.ant-table-row')).some((tr) => tr.innerText.includes('delete-loading-sample'))`,
    '新文档出现在列表',
    30000,
  )
  console.log('   测试文档已上传并出现在列表')

  const delBefore = cdp.deleteCount('/documents/')
  await cdp.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.doc-table-card .ant-table-tbody tr.ant-table-row'))
      .find((tr) => tr.innerText.includes('delete-loading-sample'))
    row.querySelector('.doc-actions button:last-child').click()
    return true
  })()`)
  await waitFor(cdp, `${BTNS_BOX}`, '删除确认弹窗')
  await sleep(400)
  console.log('   弹窗文案:', JSON.stringify(
    await cdp.evaluate(`document.querySelector('.ant-modal-container')?.innerText.replace(/\\s+/g,' ').trim()`),
  ))

  // 把 DELETE 延迟 2.5 秒，制造可采样的「删除中」
  cdp.fetchDelay = 2500
  await cdp.evaluate(`${OK_BTN}.click(); true`)
  await sleep(500)
  const during = await cdp.evaluate(modalBtnExpr)
  console.log('   删除中按钮状态:', JSON.stringify(during))
  const loadingOk = String(during.okClass).includes('ant-btn-loading')
  console.log(`   → 确认按钮 loading: ${loadingOk ? '✅' : '❌'}；disabled: ${during.okDisabled ? '✅' : '❌'}`)
  console.log(`   → 取消按钮 disabled: ${during.cancelDisabled ? '✅' : '❌'}；右上角关闭按钮已隐藏: ${during.closeBtnExists ? '❌' : '✅'}`)
  await cdp.shot('11-delete-loading')

  // 强行重复触发 3 次（含绕过 disabled 的强制派发），验证 JS 重入守卫
  for (let i = 0; i < 3; i += 1) {
    await cdp.evaluate(forceClickOkExpr)
    await sleep(150)
  }
  const stillLoading = await cdp.evaluate(modalBtnExpr)
  console.log('   重复触发 3 次后按钮仍处于:', JSON.stringify({ loading: String(stillLoading.okClass).includes('ant-btn-loading'), text: stillLoading.okText }))

  await waitFor(cdp, `!${BTNS_BOX}`, '删除完成、弹窗关闭', 30000)
  cdp.fetchDelay = 0
  await sleep(1500)
  const delAfter = cdp.deleteCount('/documents/')
  console.log(`   → DELETE /documents 请求次数: ${delAfter - delBefore}（期望 1）`)
  const rowGone = await cdp.evaluate(
    `!Array.from(document.querySelectorAll('.doc-table-card .ant-table-tbody tr.ant-table-row')).some((tr) => tr.innerText.includes('delete-loading-sample'))`,
  )
  console.log(`   → 列表里该行已消失: ${rowGone ? '✅' : '❌'}\n`)

  /* ================================================================
   * 场景 B：知识库页删除
   * ================================================================ */
  console.log('=== 场景 B：知识库页删除 ===')
  await cdp.send('Page.navigate', { url: `${APP}/knowledge-base` })
  await waitFor(cdp, `document.querySelector('.kb-table-card .ant-table-tbody')`, '知识库表格', 60000)
  await sleep(1200)

  await cdp.evaluate(
    `Array.from(document.querySelectorAll('button')).find((b) => b.innerText.replace(/\\s+/g, '') === '新建知识库')?.click(); true`,
  )
  await waitFor(cdp, `document.querySelector('.ant-modal-container input#name')`, '新建知识库弹窗')
  await cdp.evaluate(`(() => {
    const el = document.querySelector('.ant-modal-container input#name')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(TEMP_KB)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(400)
  // 注意：antd 会给两字按钮插空格（「创 建」），用弹窗主按钮选择器最稳
  await cdp.evaluate(`document.querySelector('.ant-modal-footer button.ant-btn-primary')?.click(); true`)
  await waitFor(cdp, `!document.querySelector('.ant-modal-container')`, '新建弹窗关闭', 30000)
  await waitFor(
    cdp,
    `Array.from(document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row')).some((tr) => tr.innerText.includes(${JSON.stringify(TEMP_KB)}))`,
    '临时知识库出现在列表',
    30000,
  )
  console.log('   临时知识库已创建')

  const kbDelBefore = cdp.deleteCount('/knowledge-bases/')
  await realClick(
    cdp,
    `(() => {
      const row = Array.from(document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row'))
        .find((tr) => tr.innerText.includes(${JSON.stringify(TEMP_KB)}))
      return row ? row.querySelector('button.ant-btn-text') : null
    })()`,
  )
  await waitFor(cdp, `document.querySelector('.ant-dropdown-menu-item')`, '行操作菜单')
  await sleep(600)
  await realClick(
    cdp,
    `Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find((el) => el.innerText.replace(/\\s+/g, '').includes('删除'))`,
  )
  await sleep(600)
  console.log('   诊断:', JSON.stringify(await cdp.evaluate(`({
    modalCount: document.querySelectorAll('.ant-modal-container').length,
    menuStillOpen: !!document.querySelector('.ant-dropdown-menu-item'),
    text: document.querySelector('.ant-modal-container')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60) ?? null,
  })`)))
  await waitFor(cdp, `${BTNS_BOX}`, '删除确认弹窗')
  await sleep(400)
  console.log('   弹窗文案:', JSON.stringify(
    await cdp.evaluate(`document.querySelector('.ant-modal-container')?.innerText.replace(/\\s+/g,' ').trim()`),
  ))

  cdp.fetchDelay = 2500
  await cdp.evaluate(`${OK_BTN}.click(); true`)
  await sleep(500)
  const kbDuring = await cdp.evaluate(modalBtnExpr)
  console.log('   删除中按钮状态:', JSON.stringify(kbDuring))
  console.log(`   → 确认按钮 loading: ${String(kbDuring.okClass).includes('ant-btn-loading') ? '✅' : '❌'}；disabled: ${kbDuring.okDisabled ? '✅' : '❌'}`)
  await cdp.shot('12-kb-delete-loading')

  for (let i = 0; i < 3; i += 1) {
    await cdp.evaluate(forceClickOkExpr)
    await sleep(150)
  }
  await waitFor(cdp, `!${BTNS_BOX}`, '删除完成、弹窗关闭', 30000)
  cdp.fetchDelay = 0
  await sleep(2000)
  const kbDelAfter = cdp.deleteCount('/knowledge-bases/')
  console.log(`   → DELETE /knowledge-bases 请求次数: ${kbDelAfter - kbDelBefore}（期望 1）`)
  const kbGone = await cdp.evaluate(
    `!Array.from(document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row')).some((tr) => tr.innerText.includes(${JSON.stringify(TEMP_KB)}))`,
  )
  console.log(`   → 列表里该知识库已消失: ${kbGone ? '✅' : '❌'}\n`)

  /* ================================================================
   * 场景 C：对话历史页删除（本地存储，无网络往返）
   * ================================================================ */
  console.log('=== 场景 C：对话历史页删除 ===')
  await cdp.evaluate(`(() => {
    const mk = (id, title) => ({
      id, title, updatedAt: '2026-10-13 21:30:00', messageCount: 2, createdAt: '2026-10-13 21:30:00',
      messages: [
        { id: id + '-m1', role: 'user', content: '你好', createdAt: '2026-10-13 21:30:00' },
        { id: id + '-m2', role: 'assistant', content: '你好，有什么可以帮你？', createdAt: '2026-10-13 21:30:01' },
      ],
    })
    window.localStorage.setItem('rag:conversations', JSON.stringify({
      'conv-loading-a': mk('conv-loading-a', '删除loading测试会话A'),
      'conv-loading-b': mk('conv-loading-b', '删除loading测试会话B'),
    }))
    return true
  })()`)
  await cdp.send('Page.navigate', { url: `${APP}/conversations` })
  await waitFor(cdp, `document.querySelectorAll('.conv-card').length === 2`, '两张会话卡片', 30000)
  console.log('   注入后卡片数:', await cdp.evaluate(`document.querySelectorAll('.conv-card').length`))

  await realClick(cdp, `document.querySelectorAll('.conv-card')[0]?.querySelector('.conv-card__delete')`)
  await waitFor(cdp, `${BTNS_BOX}`, '删除会话确认弹窗')
  await sleep(400)
  console.log('   弹窗文案:', JSON.stringify(
    await cdp.evaluate(`document.querySelector('.ant-modal-container')?.innerText.replace(/\\s+/g,' ').trim()`),
  ))
  await cdp.evaluate(`${OK_BTN}.click(); true`)
  await waitFor(cdp, `document.querySelectorAll('.conv-card').length === 1`, '删除后只剩 1 张卡片', 20000)
  console.log('   删除后卡片数:', await cdp.evaluate(`document.querySelectorAll('.conv-card').length`))
  console.log('   剩余标题:', JSON.stringify(
    await cdp.evaluate(`Array.from(document.querySelectorAll('.conv-card__title')).map((e) => e.innerText.trim())`),
  ))
  console.log('   localStorage 剩余会话数:', await cdp.evaluate(
    `Object.keys(JSON.parse(window.localStorage.getItem('rag:conversations') || '{}')).length`,
  ))
  await cdp.shot('13-conversations-after-delete')

  console.log('\n未捕获异常:', cdp.errors.length === 0 ? '无 ✅' : cdp.errors.slice(0, 3))
} catch (error) {
  console.error('❌ 验证失败:', error.message)
  process.exitCode = 1
} finally {
  try {
    chrome.kill()
  } catch {
    /* 忽略 */
  }
  await sleep(500)
  process.exit(process.exitCode ?? 0)
}
