// mock 层移除后的回归验证
// A 段（5180，真实后端）：登录 → 知识库 → 文档 → 问答流式；登录页无 mock 提示
// B 段（5191，代理指向死端口 8999）：后端不可达时给出统一文案，且不再有任何假数据
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9342
const APP = 'http://127.0.0.1:5180'
const APP_DOWN = 'http://127.0.0.1:5191'
const API = 'http://127.0.0.1:8000/api/v1'
const OUT = 'H:/work/rag-frontend/.workbuddy/shots'
mkdirSync(OUT, { recursive: true })

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// ---------- 后端标准答案 ----------
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'demo', password: 'demo123456' }),
})
if (!loginRes.ok) throw new Error(`后端登录失败 ${loginRes.status}`)
const { access_token: TOKEN } = await loginRes.json()
const kbs = await fetch(`${API}/knowledge-bases`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
const docs = await fetch(`${API}/knowledge-bases/${kbs[0].id}/documents`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
console.log(`后端: ${kbs.length} 个知识库，首个库「${kbs[0].name}」${docs.length} 份文档`)

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--proxy-server=direct://', '--proxy-bypass-list=*',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--window-size=1440,1000',
  '--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/chrome-rag-nomock',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForCdp() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return } catch { /* 等 */ }
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
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('CDP 超时: ' + method)) } }, 60000)
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description ?? '未知'))
    return r.result?.value
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
  }
}
async function waitFor(cdp, expr, label, timeout = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.evaluate(`!!(${expr})`)) return
    await sleep(250)
  }
  throw new Error(`等待超时（${label}）`)
}
async function fillLogin(cdp) {
  await waitFor(cdp, `document.querySelector('#username')`, '登录表单')
  await cdp.evaluate(`(() => {
    const set = (sel, val) => {
      const el = document.querySelector(sel)
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('#username', 'demo'); set('#password', 'demo123456'); return true
  })()`)
  await cdp.evaluate(`document.querySelector('button[type="submit"]').click(); true`)
}

try {
  await waitForCdp()
  let target = null
  for (let i = 0; i < 20 && !target; i += 1) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
    target = list.find((t) => t.type === 'page' && t.url === 'about:blank') ?? list.find((t) => t.type === 'page')
    if (!target) await sleep(300)
  }
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // ================= A 段：真实后端 =================
  await cdp.send('Page.navigate', { url: `${APP}/` })
  await sleep(800)
  await cdp.evaluate(`localStorage.clear(); true`)
  await cdp.send('Page.navigate', { url: `${APP}/login` })
  await waitFor(cdp, `document.querySelector('#username')`, '登录表单')
  const hasMockHint = await cdp.evaluate(`!!document.querySelector('.login-mock-hint')`)
  const loginText = await cdp.evaluate(`document.querySelector('.login-card').innerText.replace(/\\s+/g, ' ').trim()`)
  check('登录页不再有 mock 提示', hasMockHint === false)
  check('登录页文案里无「mock / 任意账号」字样', !/mock|任意账号/i.test(loginText), loginText)
  await cdp.shot('21-login-no-mock')

  await fillLogin(cdp)
  await waitFor(cdp, `location.pathname === '/knowledge-base'`, '登录后跳转', 30000)
  await waitFor(cdp, `document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row').length > 0`, '知识库行')
  await sleep(1200)
  const kbRows = await cdp.evaluate(`document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row').length`)
  check('知识库列表来自真实后端', kbRows === kbs.length, `页面 ${kbRows} / 后端 ${kbs.length}`)

  // 文档页
  await cdp.send('Page.navigate', { url: `${APP}/documents?kbId=${encodeURIComponent(kbs[0].id)}` })
  await waitFor(cdp, `document.querySelectorAll('.doc-table-card .ant-table-tbody tr.ant-table-row').length > 0`, '文档行', 30000)
  await sleep(1200)
  const docRows = await cdp.evaluate(`document.querySelectorAll('.doc-table-card .ant-table-tbody tr.ant-table-row').length`)
  check('文档列表来自真实后端', docRows === docs.length, `页面 ${docRows} / 后端 ${docs.length}`)

  // 问答流式（验证 useChatStream → streamChat 直连）
  await cdp.send('Page.navigate', { url: `${APP}/chat` })
  await waitFor(cdp, `document.querySelector('.chat-input')`, '问答页输入框')
  await waitFor(cdp, `document.querySelector('.chat-header__right .ant-select')`, '知识库选择器')
  await sleep(800)
  // 问答页不会默认选库，先手动选「联调测试库」（已验证有可检索内容）
  await cdp.evaluate(`document.querySelector('.chat-header__right .ant-select').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`)
  await waitFor(cdp, `document.querySelectorAll('.ant-select-item-option').length > 0`, '问答页下拉')
  await cdp.evaluate(`(() => {
    const t = Array.from(document.querySelectorAll('.ant-select-item-option')).find((e) => e.innerText.includes('联调测试库'))
    for (const type of ['mousedown', 'mouseup', 'click']) t.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    return true
  })()`)
  await sleep(600)
  check('已在问答页选中知识库', await cdp.evaluate(`document.querySelector('.chat-header__right .ant-select').innerText.includes('联调测试库')`))
  await cdp.evaluate(`(() => {
    const el = document.querySelector('.chat-input')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, '切片是什么')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
  await cdp.evaluate(`(() => {
    const btn = document.querySelector('.chat-send-btn')
    btn.click(); return true
  })()`)
  await waitFor(cdp, `document.querySelectorAll('.chat-reference').length > 0`, '流式引用', 60000)
  // 引用先到、正文是逐字吐的，等正文成型（或生成本身结束）再断言
  const BOT_TEXT = `(() => {
    const nodes = document.querySelectorAll('.chat-bubble--bot .chat-bubble__text')
    return nodes.length ? nodes[nodes.length - 1].innerText.trim() : ''
  })()`
  try {
    await waitFor(cdp, `${BOT_TEXT}.length > 20`, '回答正文', 90000)
  } catch { /* 超时则用当前内容断言，下面会失败 */ }
  const answerText = await cdp.evaluate(BOT_TEXT)
  const stillStreaming = await cdp.evaluate(`!!document.querySelector('.chat-send-btn')?.innerText.includes('停止')`)
  console.log(`   回答${stillStreaming ? '（仍在生成）' : ''}: ${answerText.slice(0, 60).replace(/\\n/g, ' ')}…`)
  check('问答流式返回了真实回答', answerText.length > 20, `长度 ${answerText.length}`)
  check('回答不含 mock 兜底文案', !answerText.includes('基于当前知识库，这个问题可以从以下几个角度理解'), answerText.slice(0, 40))
  await cdp.shot('22-chat-real-stream')

  // ================= B 段：后端不可达（代理指向死端口）=================
  await cdp.send('Page.navigate', { url: `${APP_DOWN}/` })
  await sleep(800)
  await cdp.evaluate(`localStorage.clear(); true`)
  await cdp.send('Page.navigate', { url: `${APP_DOWN}/login` })
  await fillLogin(cdp)
  await waitFor(cdp, `document.querySelector('.ant-alert-error')`, '登录错误提示', 30000)
  await sleep(600)
  const errText = await cdp.evaluate(`document.querySelector('.ant-alert-error').innerText.replace(/\\s+/g, ' ').trim()`)
  const stillLogin = await cdp.evaluate(`location.pathname === '/login'`)
  check('后端不可达时给出统一文案', errText.includes('后端服务未启动或不可达'), errText)
  check('后端不可达时不再假登录（仍停在登录页）', stillLogin)
  check('后端不可达时不写入登录态', (await cdp.evaluate(`!!localStorage.getItem('rag:auth')`)) === false)
  await cdp.shot('23-backend-down-message')

  console.log('\n未捕获异常:', cdp.errors.length === 0 ? '无' : cdp.errors.slice(0, 3))
  check('控制台零报错', cdp.errors.length === 0)
  if (failures.length > 0) {
    console.error('\n存在失败项:', failures)
    process.exitCode = 1
  } else {
    console.log('\n全部通过')
  }
} catch (error) {
  console.error('脚本失败:', error.message)
  process.exitCode = 1
} finally {
  try { spawn('taskkill', ['/F', '/T', '/PID', String(chrome.pid)], { stdio: 'ignore' }) } catch { /* 忽略 */ }
}
