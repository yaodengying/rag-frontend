// 知识库页「原型对齐」端到端验证（Chrome headless + CDP）
// 覆盖：4 张统计卡数字正确性（对照后端 API）→ 表格 8 列（切片数/引用次数/状态徽标）
//      → 排序 → 搜索 → 问答后 kbId 落盘与引用数联动
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9337
const APP = 'http://127.0.0.1:5180'
const API = 'http://127.0.0.1:8000/api/v1'
const OUT = 'H:/work/rag-frontend/.workbuddy/shots'
mkdirSync(OUT, { recursive: true })

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// ---------- 先从后端拿「标准答案」 ----------
async function api(path, token) {
  const res = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'demo', password: 'demo123456' }),
})
if (!loginRes.ok) throw new Error(`后端登录失败 ${loginRes.status}`)
const { access_token: TOKEN } = await loginRes.json()

const kbsRaw = await api('/knowledge-bases', TOKEN)
const expected = []
for (const kb of kbsRaw) {
  const docs = await api(`/knowledge-bases/${kb.id}/documents`, TOKEN)
  const statuses = docs.map((d) => d.status)
  const derived = docs.length === 0 ? '空库'
    : statuses.some((s) => s === 'processing') ? '处理中'
    : statuses.some((s) => s === 'failed') ? '部分失败'
    : '就绪'
  expected.push({
    id: kb.id,
    name: kb.name,
    docCount: kb.doc_count,
    chunks: docs.reduce((s, d) => s + (d.chunk_count ?? 0), 0),
    status: derived,
  })
}
const expDocTotal = expected.reduce((s, k) => s + k.docCount, 0)
const expChunkTotal = expected.reduce((s, k) => s + k.chunks, 0)
const SEED_KB = expected.find((k) => k.name === '联调测试库') ?? expected[0]
const SEED_CITATIONS = 2
console.log('后端标准答案:', JSON.stringify(expected))

// ---------- 启动浏览器 ----------
const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    '--proxy-server=direct://', '--proxy-bypass-list=*',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--window-size=1440,1000',
    '--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/chrome-rag-kb',
    'about:blank',
  ],
  { stdio: 'ignore' },
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForCdp() {
  for (let i = 0; i < 60; i += 1) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (res.ok) return } catch { /* 等待 */ }
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
        if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('CDP 超时: ' + method)) }
      }, 120000)
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
async function waitFor(cdp, expression, label, timeout = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.evaluate(`!!(${expression})`)) return
    await sleep(300)
  }
  throw new Error(`等待超时（${label}）`)
}

const readCardsExpr = `Array.from(document.querySelectorAll('.kb-stat-card')).map((c) => ({
  label: c.querySelector('.kb-stat-card__label')?.innerText?.trim(),
  value: c.querySelector('.kb-stat-card__value')?.innerText?.trim(),
  hint: c.querySelector('.kb-stat-card__hint')?.innerText?.trim(),
}))`
const readRowsExpr = `Array.from(document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row')).map((tr) =>
  Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.replace(/\\s+/g, ' ').trim()),
)`

try {
  await waitForCdp()
  // 新版 Chrome 的 /json/new 只接受 PUT，直接从 /json/list 取已打开的 about:blank 页
  let target = null
  for (let i = 0; i < 20 && !target; i += 1) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
    target = list.find((t) => t.type === 'page' && t.url === 'about:blank') ?? list.find((t) => t.type === 'page')
    if (!target) await sleep(300)
  }
  if (!target) throw new Error('没有可用的 page target')
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // ---------- 1. 登录 ----------
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
  await waitFor(cdp, `location.pathname === '/knowledge-base'`, '登录后跳转', 30000)
  console.log('1) 登录成功并进入知识库页')

  // ---------- 2. 预置一条带 kbId 与引用的本地会话 ----------
  await cdp.evaluate(`(() => {
    const key = 'rag:conversations'
    const store = JSON.parse(localStorage.getItem(key) || '{}')
    store['seed-conv-1'] = {
      id: 'seed-conv-1',
      title: '种子会话：验证引用统计',
      createdAt: '2026-10-13 21:00:00',
      updatedAt: '2026-10-13 21:00:10',
      messageCount: 2,
      kbId: ${JSON.stringify(SEED_KB.id)},
      messages: [
        { id: 'm1', role: 'user', content: '种子问题', createdAt: '2026-10-13 21:00:00' },
        { id: 'm2', role: 'assistant', content: '种子回答', createdAt: '2026-10-13 21:00:10',
          references: [
            { title: 'chunk-intro.txt', content: '片段一', score: 0.9 },
            { title: 'chunk-intro.txt', content: '片段二', score: 0.8 },
          ] },
      ],
    }
    localStorage.setItem(key, JSON.stringify(store))
    return true
  })()`)

  // ---------- 3. 统计卡（切片数要等文档明细回来） ----------
  await cdp.send('Page.navigate', { url: `${APP}/knowledge-base` })
  await waitFor(cdp, `document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row').length > 0`, '表格行')
  await waitFor(cdp, `!document.querySelector('.kb-table-card .ant-table-tbody')?.innerText.includes('—') || Array.from(document.querySelectorAll('.kb-stat-card')).some((c) => c.innerText.includes('切片总数'))`, '统计卡')
  await sleep(1500) // 等文档明细 enrich
  const cards = await cdp.evaluate(readCardsExpr)
  console.log('   统计卡:', JSON.stringify(cards))
  const byLabel = Object.fromEntries(cards.map((c) => [c.label, c]))
  check('统计卡共 4 张（原型布局）', cards.length === 4, `实际 ${cards.length}`)
  check('知识库总数 = 后端库数', byLabel['知识库总数']?.value === String(expected.length), byLabel['知识库总数']?.value)
  check('文档总数 = 后端聚合', byLabel['文档总数']?.value === String(expDocTotal), `期望 ${expDocTotal}`)
  check('切片总数 = 后端文档 chunk 聚合', byLabel['切片总数']?.value === String(expChunkTotal), `期望 ${expChunkTotal}`)
  check('累计引用 = 种子引用数', byLabel['累计引用']?.value === String(SEED_CITATIONS), byLabel['累计引用']?.value)
  const kbCardHint = byLabel['知识库总数']?.hint ?? ''
  const expReady = expected.filter((k) => k.status === '就绪').length
  check('知识库总数卡 hint 显示就绪数', kbCardHint.includes(`就绪 ${expReady} 个`), kbCardHint)
  await cdp.shot('14-kb-page-proto')

  // ---------- 4. 表格行数据对照 ----------
  const rows = await cdp.evaluate(readRowsExpr)
  console.log('   表格行:', JSON.stringify(rows))
  check('表格行数 = 知识库数', rows.length === expected.length, `实际 ${rows.length}`)
  for (const exp of expected) {
    const row = rows.find((r) => r[0] === exp.name)
    if (!row) { check(`行「${exp.name}」存在`, false); continue }
    check(`「${exp.name}」文档数`, row[2] === String(exp.docCount), row[2])
    check(`「${exp.name}」切片数`, row[3] === String(exp.chunks), `期望 ${exp.chunks}，实际 ${row[3]}`)
    const citation = row[4]
    check(`「${exp.name}」引用次数`, exp.id === SEED_KB.id ? citation === String(SEED_CITATIONS) : citation === '—', citation)
    check(`「${exp.name}」状态徽标 = ${exp.status}`, row[6] === exp.status, row[6])
  }

  // ---------- 5. 排序：文档数 ----------
  await cdp.evaluate(`(() => {
    const th = Array.from(document.querySelectorAll('.kb-table-card thead th')).find((e) => e.innerText.includes('文档数'))
    th.querySelector('.ant-table-column-sorters')?.click() ?? th.click()
    return true
  })()`)
  await sleep(600)
  const sortedAsc = await cdp.evaluate(readRowsExpr)
  check('按文档数排序后首行是最小值', Number(sortedAsc[0][2]) === Math.min(...expected.map((k) => k.docCount)), `首行 ${sortedAsc[0][2]}`)
  await cdp.evaluate(`(() => {
    const th = Array.from(document.querySelectorAll('.kb-table-card thead th')).find((e) => e.innerText.includes('文档数'))
    th.querySelector('.ant-table-column-sorters')?.click(); return true
  })()`)
  await sleep(600)

  // ---------- 6. 搜索过滤 ----------
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.kb-search input')
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '联调')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(500)
  const filteredRows = await cdp.evaluate(readRowsExpr)
  check('搜索「联调」过滤到 1 行', filteredRows.length === 1 && filteredRows[0][0].includes('联调'), `行数 ${filteredRows.length}`)
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.kb-search input')
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(400)

  // ---------- 7. 问答一轮：验证 kbId 落盘（真实后端流式） ----------
  await cdp.send('Page.navigate', { url: `${APP}/chat` })
  await waitFor(cdp, `document.querySelector('.chat-input')`, '问答页输入框')
  await sleep(800)
  // 切到联调测试库（如果默认不是它）
  const needSwitch = await cdp.evaluate(`!document.querySelector('.chat-header__right .ant-select')?.innerText.includes('联调测试库')`)
  if (needSwitch) {
    await cdp.evaluate(`document.querySelector('.chat-header__right .ant-select').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`)
    await waitFor(cdp, `document.querySelectorAll('.ant-select-item-option').length > 0`, '问答页下拉')
    await cdp.evaluate(`(() => {
      const t = Array.from(document.querySelectorAll('.ant-select-item-option')).find((e) => e.innerText.includes('联调测试库'))
      for (const type of ['mousedown', 'mouseup', 'click']) t.dispatchEvent(new MouseEvent(type, { bubbles: true }))
      return true
    })()`)
    await sleep(600)
  }
  await cdp.evaluate(`(() => {
    const el = document.querySelector('.chat-input')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, '知识库切片是什么？推荐多大？')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await cdp.evaluate(`document.querySelector('.chat-send-btn').click(); true`)
  console.log('7) 已发送问答，等待流式完成（真实后端）…')
  // 以「引用来源卡片出现」为完成信号：只有流式 done 后引用区才渲染，
  // 不会被用户气泡里的关键词提前命中
  await waitFor(cdp, `document.querySelectorAll('.chat-reference').length > 0`, '回答完成（引用卡片出现）', 150000)
  await sleep(1200) // 等 finally 里的 saveConversation
  const convStore = await cdp.evaluate(`JSON.parse(localStorage.getItem('rag:conversations') || '{}')`)
  const live = Object.values(convStore).filter((c) => c.id !== 'seed-conv-1')
  check('问答后会话已落盘', live.length >= 1)
  check('落盘会话带 kbId（引用可按库分桶）', live.every((c) => typeof c.kbId === 'string' && c.kbId.length > 0), JSON.stringify(live.map((c) => c.kbId)))
  const liveRefs = live
    .flatMap((c) => c.messages)
    .filter((m) => m.role === 'assistant')
    .reduce((sum, m) => sum + (m.references?.length ?? 0), 0)
  check('真实回答带回引用（后端 sources 命中）', liveRefs > 0, `本轮引用 ${liveRefs} 条`)

  // ---------- 8. 回到知识库页：引用数联动 ----------
  await cdp.send('Page.navigate', { url: `${APP}/knowledge-base` })
  await waitFor(cdp, `document.querySelectorAll('.kb-table-card .ant-table-tbody tr.ant-table-row').length > 0`, '表格行')
  await sleep(1500)
  const cards2 = await cdp.evaluate(readCardsExpr)
  const quote2 = Number(cards2.find((c) => c.label === '累计引用')?.value ?? '0')
  const expQuote = SEED_CITATIONS + liveRefs
  check('累计引用 = 种子引用 + 本轮真实引用', quote2 === expQuote, `期望 ${expQuote}，实际 ${quote2}`)
  const rows2 = await cdp.evaluate(readRowsExpr)
  const seedRow = rows2.find((r) => r[0] === SEED_KB.name)
  check('「联调测试库」行引用次数同步', seedRow && Number(seedRow[4]) === expQuote, `${seedRow?.[4]}（期望 ${expQuote}）`)
  await cdp.shot('15-kb-page-citations')

  // ---------- 汇总 ----------
  console.log('\\n未捕获异常:', cdp.errors.length === 0 ? '无' : cdp.errors.slice(0, 3))
  check('控制台零报错', cdp.errors.length === 0)
  if (failures.length > 0) {
    console.error('\\n存在失败项:', failures)
    process.exitCode = 1
  } else {
    console.log('\\n全部通过')
  }
} catch (error) {
  console.error('脚本失败:', error.message)
  process.exitCode = 1
} finally {
  // Git Bash 的 kill 收不掉 Windows 原生进程树，用 taskkill /T 连子进程一起
  try { spawn('taskkill', ['/F', '/T', '/PID', String(chrome.pid)], { stdio: 'ignore' }) } catch { /* 忽略 */ }
}
