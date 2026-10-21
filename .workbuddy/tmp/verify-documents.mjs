// 文档管理页端到端验证（Chrome headless + CDP）
// 覆盖：跨知识库聚合 → 详情抽屉 → 切换知识库筛选（上传目标跟随）→ 上传队列进度 → 列表刷新 → 删除确认 → 回到全部知识库
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9336
const APP = 'http://127.0.0.1:5180'
const OUT = 'H:/work/rag-frontend/.workbuddy/shots'
const UPLOAD_FILE = 'H:/work/rag-frontend/.workbuddy/tmp/upload-sample.txt'
const TARGET_KB = '联调测试库'
mkdirSync(OUT, { recursive: true })

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
    '--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/chrome-rag-docs',
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
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('ws 失败')))
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description ?? '')
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
}

async function waitFor(cdp, expression, label, timeout = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.evaluate(`!!(${expression})`)) return
    await sleep(300)
  }
  throw new Error(`等待超时（${label}）: ${expression}`)
}

/** 展开第 index 个匹配的 .ant-select，并选中文本**包含** text 的选项（antd v6 的触发元素是外层 .ant-select） */
async function pickOption(cdp, selectSelector, text, index = 0) {
  await cdp.evaluate(
    `document.querySelectorAll(${JSON.stringify(selectSelector)})[${index}].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`,
  )
  await waitFor(cdp, `document.querySelectorAll('.ant-select-item-option').length > 0`, `下拉选项(${text})`)
  const picked = await cdp.evaluate(`(() => {
    const target = Array.from(document.querySelectorAll('.ant-select-item-option'))
      .find((e) => e.innerText.includes(${JSON.stringify(text)}))
    if (!target) return false
    for (const type of ['mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    }
    return true
  })()`)
  if (!picked) {
    const options = await cdp.evaluate(
      `Array.from(document.querySelectorAll('.ant-select-item-option')).map((e) => e.innerText.trim())`,
    )
    throw new Error(`下拉里没有「${text}」，实际选项：${JSON.stringify(options)}`)
  }
  await sleep(700)
}

const rowsExpr = `Array.from(document.querySelectorAll('.doc-table-card .ant-table-tbody tr.ant-table-row')).map((tr) => {
  const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.replace(/\\s+/g, ' ').trim())
  return { filename: cells[0] || '', kbName: cells[1] || '', uploadedAt: cells[2] || '', status: cells[3] || '', chunks: cells[4] || '' }
})`

const titleExpr = `document.querySelector('.doc-table-title')?.innerText.replace(/\\s+/g,' ').trim()`
const uploadTargetExpr = `document.querySelector('.doc-upload-bar .ant-select-content')?.innerText.trim()`

try {
  await waitForCdp()
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('DOM.enable')

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

  // ---------- 1. 跨知识库聚合 ----------
  await cdp.send('Page.navigate', { url: `${APP}/documents` })
  await waitFor(cdp, `document.querySelector('.doc-table-card .ant-table-tbody tr.ant-table-row')`, '文档表格', 90000)
  await sleep(1500)

  console.log('1) 地址:', await cdp.evaluate(`location.pathname + location.search`))
  console.log('   标题:', JSON.stringify(await cdp.evaluate(titleExpr)))
  const initialRows = await cdp.evaluate(rowsExpr)
  console.log(`   聚合到 ${initialRows.length} 行，知识库取值:`,
    JSON.stringify([...new Set(initialRows.map((r) => r.kbName))]))
  console.log('   上传目标:', JSON.stringify(await cdp.evaluate(uploadTargetExpr)))
  console.log('   行样例:', JSON.stringify(initialRows[0]))

  // ---------- 2. 详情抽屉 ----------
  // 注意：antd v6 的抽屉内容区叫 .ant-drawer-section（v5 是 .ant-drawer-content），用 .ant-drawer-body 最稳
  await cdp.evaluate(
    `document.querySelector('.doc-table-card .ant-table-tbody tr.ant-table-row .doc-actions button').click(); true`,
  )
  await waitFor(cdp, `document.querySelector('.ant-drawer-body')`, '详情抽屉')
  await sleep(700)
  console.log('2) 抽屉内容:', JSON.stringify(
    (await cdp.evaluate(`document.querySelector('.ant-drawer-body')?.innerText.replace(/\\s+/g,' ').trim()`))?.slice(0, 200),
  ))
  await cdp.shot('08-documents-drawer')
  await cdp.evaluate(`document.querySelector('.ant-drawer-close').click(); true`)
  await sleep(700)

  // ---------- 3. 切换知识库筛选（上传目标应跟随） ----------
  await pickOption(cdp, '.doc-table-toolbar .ant-select', TARGET_KB)
  await sleep(2000)
  const filteredRows = await cdp.evaluate(rowsExpr)
  console.log(`3) 筛选「${TARGET_KB}」→ ${filteredRows.length} 行，知识库取值:`,
    JSON.stringify([...new Set(filteredRows.map((r) => r.kbName))]))
  console.log('   地址栏:', await cdp.evaluate(`location.search`))
  console.log('   上传目标已跟随:', JSON.stringify(await cdp.evaluate(uploadTargetExpr)))

  // ---------- 4. 上传文件 ----------
  const doc = await cdp.send('DOM.getDocument', { depth: -1 })
  const inputNode = await cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '.doc-upload input[type=file]',
  })
  if (!inputNode.nodeId) throw new Error('没找到上传的 file input')
  await cdp.send('DOM.setFileInputFiles', { files: [UPLOAD_FILE], nodeId: inputNode.nodeId })

  await waitFor(cdp, `document.querySelector('.doc-queue__item')`, '上传队列出现', 20000)
  const firstPhase = await cdp.evaluate(
    `document.querySelector('.doc-queue__item .ant-tag')?.innerText.trim()`,
  )
  console.log('4) 队列已出现，首个状态:', JSON.stringify(firstPhase))
  await waitFor(cdp, `document.querySelector('.doc-queue__item--done')`, '上传完成', 180000)
  await sleep(3000)
  console.log('   队列条目:', JSON.stringify(
    await cdp.evaluate(`document.querySelector('.doc-queue__item')?.innerText.replace(/\\s+/g,' ').trim()`),
  ))
  console.log('   队列统计:', JSON.stringify(
    await cdp.evaluate(`document.querySelector('.doc-queue__title')?.innerText.replace(/\\s+/g,' ').trim()`),
  ))
  await cdp.shot('09-documents-uploaded')

  // ---------- 5. 列表刷新 ----------
  await waitFor(
    cdp,
    `Array.from(document.querySelectorAll('.doc-table-card .ant-table-tbody tr.ant-table-row')).some((tr) => tr.innerText.includes('upload-sample'))`,
    '新文档出现在列表',
    60000,
  )
  const afterUpload = await cdp.evaluate(rowsExpr)
  console.log('5) 新文档行:', JSON.stringify(afterUpload.find((r) => r.filename.includes('upload-sample'))))
  console.log('   标题:', JSON.stringify(await cdp.evaluate(titleExpr)))

  // ---------- 6. 删除确认 ----------
  await cdp.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.doc-table-card .ant-table-tbody tr.ant-table-row'))
      .find((tr) => tr.innerText.includes('upload-sample'))
    row.querySelectorAll('.doc-actions button')[1].click()
    return true
  })()`)
  await waitFor(cdp, `document.querySelector('.ant-modal-container')`, '删除确认弹窗')
  await sleep(600)
  console.log('6) 删除弹窗:', JSON.stringify(
    await cdp.evaluate(`document.querySelector('.ant-modal-container')?.innerText.replace(/\\s+/g,' ').trim()`),
  ))
  await cdp.evaluate(`document.querySelector('.ant-modal-footer button.ant-btn-primary').click(); true`)
  await waitFor(
    cdp,
    `!Array.from(document.querySelectorAll('.doc-table-card .ant-table-tbody tr.ant-table-row')).some((tr) => tr.innerText.includes('upload-sample'))`,
    '文档已从列表移除',
    30000,
  )
  await sleep(1500)
  const afterDelete = await cdp.evaluate(rowsExpr)
  console.log('7) 删除后剩', afterDelete.length, '行；upload-sample 还在:',
    afterDelete.some((r) => r.filename.includes('upload-sample')))
  await cdp.shot('10-documents-after-delete')

  // ---------- 7. 切回全部知识库 ----------
  await pickOption(cdp, '.doc-table-toolbar .ant-select', '全部知识库')
  await sleep(2500)
  const backRows = await cdp.evaluate(rowsExpr)
  console.log(`8) 切回「全部知识库」→ ${backRows.length} 行，知识库取值:`,
    JSON.stringify([...new Set(backRows.map((r) => r.kbName))]))
  console.log('   地址栏:', JSON.stringify(await cdp.evaluate(`location.search`)))

  // ---------- 8. 状态筛选 ----------
  await pickOption(cdp, '.doc-table-toolbar .ant-select', '已完成', 1)
  await sleep(1200)
  const statusRows = await cdp.evaluate(rowsExpr)
  console.log(`9) 状态筛选「已完成」→ ${statusRows.length} 行，状态取值:`,
    JSON.stringify([...new Set(statusRows.map((r) => r.status))]))

  console.log('   未捕获异常:', cdp.errors.length === 0 ? '无' : cdp.errors.slice(0, 3))
} catch (error) {
  console.error('验证失败:', error.message)
  process.exitCode = 1
} finally {
  chrome.kill()
}
