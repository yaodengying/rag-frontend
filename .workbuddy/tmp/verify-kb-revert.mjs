// 知识库页「操作」菜单回退验证：菜单应为「查看文档 / 编辑 / 删除」，且归档功能已移除。
// 覆盖：状态列渲染恢复 → 菜单三项文案 → 「查看文档」跳转 → 刷新后仍无归档项 → localStorage 不再写入归档键
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9341
const APP = 'http://127.0.0.1:5180'
const API = 'http://127.0.0.1:8000/api/v1'
const OUT = 'H:/work/rag-frontend/.workbuddy/shots'
const ARCHIVE_KEY = 'rag:archived-kbs'
mkdirSync(OUT, { recursive: true })

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// ---------- 后端标准答案（状态列 = 由文档状态派生） ----------
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'demo', password: 'demo123456' }),
})
if (!loginRes.ok) throw new Error(`后端登录失败 ${loginRes.status}`)
const { access_token: TOKEN } = await loginRes.json()
const kbs = await fetch(`${API}/knowledge-bases`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
const expected = []
for (const kb of kbs) {
  const docs = await fetch(`${API}/knowledge-bases/${kb.id}/documents`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
  const derived = docs.length === 0 && kb.doc_count === 0 ? '空库'
    : docs.some((d) => d.status === 'pending' || d.status === 'processing') ? '处理中'
    : docs.some((d) => d.status === 'failed') ? '部分失败'
    : '就绪'
  expected.push({ id: kb.id, name: kb.name, status: derived })
}
console.log('后端标准答案:', JSON.stringify(expected))

// ---------- 浏览器 ----------
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--proxy-server=direct://', '--proxy-bypass-list=*',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--window-size=1440,1000',
  '--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/chrome-rag-revert',
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
/** 真实鼠标点击（rc-menu 对合成事件不敏感，必须走 Input 域） */
async function realClick(cdp, elementExpr) {
  const rect = await cdp.evaluate(`(() => {
    const el = ${elementExpr}
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!rect) throw new Error('元素不存在: ' + elementExpr)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await sleep(400)
}
const MENU_TEXT = `Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).map((e) => e.innerText.replace(/\\s+/g, ''))`
const ROW_DATA = `Array.from(document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row')).map((tr) => ({
  name: tr.querySelector('td')?.innerText.trim(),
  status: tr.querySelectorAll('td')[6]?.innerText.trim(),
}))`
const OPEN_ROW_MENU = `document.querySelector('.kb-table-card .ant-table-tbody tr.ant-table-row td:last-child button')`
const CLICK_MENU_ITEM = (text) => `Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find((e) => e.innerText.replace(/\\s+/g, '') === '${text}')`

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

  // ---------- 1. 登录（复用 user-data-dir 会有残留，先清） ----------
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
  await waitFor(cdp, `location.pathname === '/knowledge-base'`, '跳转知识库页', 30000)
  await waitFor(cdp, `document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row').length > 0`, '表格行')
  await sleep(1500)
  console.log('1) 登录并进入知识库页')

  // ---------- 2. 状态列已恢复渲染 ----------
  const rows0 = await cdp.evaluate(ROW_DATA)
  console.log('2) 表格行:', JSON.stringify(rows0))
  check('表格行数 = 后端知识库数', rows0.length === expected.length, `实际 ${rows0.length}`)
  const blank = rows0.filter((r) => !r.status)
  check('「状态」列每行都有徽标（不再是空白）', blank.length === 0, JSON.stringify(blank))
  for (const exp of expected) {
    const row = rows0.find((r) => r.name === exp.name)
    check(`「${exp.name}」状态列 = ${exp.status}`, row?.status === exp.status, row?.status)
  }
  check('状态列无「已归档」残留', !rows0.some((r) => r.status === '已归档'))
  await cdp.shot('18-kb-status-restored')

  // ---------- 3. 打开「操作」菜单，核对文案为 查看文档/编辑/删除 ----------
  await realClick(cdp, OPEN_ROW_MENU)
  await waitFor(cdp, `document.querySelectorAll('.ant-dropdown-menu-item').length > 0`, '操作菜单')
  const menu1 = await cdp.evaluate(MENU_TEXT)
  console.log('3) 菜单项:', JSON.stringify(menu1))
  check('菜单共 3 项', menu1.length === 3, `实际 ${menu1.length}`)
  check('菜单含「查看文档」', menu1.includes('查看文档'))
  check('菜单含「编辑」', menu1.includes('编辑'))
  check('菜单含「删除」', menu1.includes('删除'))
  check('菜单不再含「归档」', !menu1.some((t) => t.includes('归档')), JSON.stringify(menu1))
  await cdp.shot('19-kb-action-reverted')

  // ---------- 4. 点「查看文档」跳转文档页（带 kbId） ----------
  const firstKb = kbs.find((k) => k.name === rows0[0].name)
  await realClick(cdp, CLICK_MENU_ITEM('查看文档'))
  await waitFor(cdp, `location.pathname === '/documents'`, '跳转文档页', 20000)
  await sleep(1200)
  const url = await cdp.evaluate(`location.search`)
  check('「查看文档」跳到 /documents 并带 kbId', url.includes(`kbId=${firstKb.id}`), url)
  await cdp.shot('20-kb-view-docs')

  // ---------- 5. 回到知识库页：刷新后菜单依旧无归档，且未写归档键 ----------
  await cdp.send('Page.navigate', { url: `${APP}/knowledge-base` })
  await waitFor(cdp, `document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row').length > 0`, '表格行')
  await sleep(1200)
  await realClick(cdp, OPEN_ROW_MENU)
  await waitFor(cdp, `document.querySelectorAll('.ant-dropdown-menu-item').length > 0`, '操作菜单')
  const menu2 = await cdp.evaluate(MENU_TEXT)
  check('刷新后菜单仍为 查看文档/编辑/删除', JSON.stringify(menu2) === JSON.stringify(['查看文档', '编辑', '删除']), JSON.stringify(menu2))
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  const archiveKey = await cdp.evaluate(`localStorage.getItem('${ARCHIVE_KEY}')`)
  check('localStorage 不再出现归档键', archiveKey === null, String(archiveKey))
  const rowsAfter = await cdp.evaluate(ROW_DATA)
  check('刷新后状态列仍正常渲染', rowsAfter.every((r) => r.status))

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
