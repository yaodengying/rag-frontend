// 599 代理标记机制移除后的行为验证
// 代理指向死端口 8999：确认后端不可达时走 Vite 默认代理错误处理，
// 页面显示什么文案、是否仍停在登录页、是否写入登录态。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9346
const APP = 'http://127.0.0.1:5192'
const OUT = 'H:/work/rag-frontend/.workbuddy/shots'
mkdirSync(OUT, { recursive: true })

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--proxy-server=direct://', '--proxy-bypass-list=*',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--window-size=1440,1000',
  '--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/chrome-rag-no599',
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
async function waitFor(cdp, expr, label, timeout = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.evaluate(`!!(${expr})`)) return
    await sleep(250)
  }
  throw new Error(`等待超时（${label}）`)
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

  await cdp.send('Page.navigate', { url: `${APP}/` })
  await sleep(800)
  await cdp.evaluate(`localStorage.clear(); true`)
  await cdp.send('Page.navigate', { url: `${APP}/login` })
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

  await waitFor(cdp, `document.querySelector('.ant-alert-error')`, '登录错误提示', 30000)
  await sleep(600)
  const errText = await cdp.evaluate(`document.querySelector('.ant-alert-error').innerText.replace(/\\s+/g, ' ').trim()`)
  const stillLogin = await cdp.evaluate(`location.pathname === '/login'`)
  const hasAuth = await cdp.evaluate(`!!localStorage.getItem('rag:auth')`)
  console.log(`   登录页错误文案: ${errText}`)
  check('后端不可达时仍停在登录页（无假登录）', stillLogin)
  check('后端不可达时不写入登录态', hasAuth === false)
  check('不再出现已移除的统一文案', !errText.includes('后端服务未启动或不可达'), errText)
  await cdp.shot('24-backend-down-after-599-removal')

  // 知识库页：后端不在时的表现
  await cdp.send('Page.navigate', { url: `${APP}/knowledge-base` })
  await sleep(3500)
  const kbState = await cdp.evaluate(`(() => {
    const empty = document.querySelector('.ant-empty')
    const rows = document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row').length
    return { rows, empty: !!empty, emptyText: empty ? empty.innerText.replace(/\\s+/g, ' ').trim() : '' }
  })()`)
  console.log(`   知识库页: rows=${kbState.rows} empty=${kbState.empty} "${kbState.emptyText}"`)
  check('后端不在时知识库页不显示任何假数据', kbState.rows === 0, `rows=${kbState.rows}`)

  console.log('\n未捕获异常:', cdp.errors.length === 0 ? '无' : cdp.errors.slice(0, 3))
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
