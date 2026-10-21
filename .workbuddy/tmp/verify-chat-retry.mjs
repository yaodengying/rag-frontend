/**
 * 端到端验证：「流式问答是否重试」由前端用户选择。
 *
 * 为什么用一个脚本化的 SSE 测试替身而不是真后端：
 *   本机 Milvus 因主机休眠后 etcd 会话失效而反复 exit=134，起不来（与本次改动无关），
 *   而这条链路的关键正是「事件序列 + 请求体字段」——把它编排成确定性的脚本，
 *   比依赖检索引擎出结果更能把不变量钉死（拒答那一路本来就要求"检索不到"）。
 *   SSE 报文的形状逐字抄自后端 `app/api/v1/chat.py` 的 `_sse_format`。
 *
 * 覆盖：
 *   A. 服务端默认 false → 开关初始关；拒答 → 出现「再找一次」→ 点击后
 *      第二个请求带 enable_retry=true 且复用同一条消息（不新增气泡）
 *   B. 「不用了」收起提示
 *   C. 服务端默认 true → 开关初始开；开着时一次请求就走完改写重试（无提示）
 *   D. **显式 false 压过 true 的默认值**（关掉开关后请求必须带 enable_retry=false）
 *   E. /chat/options 读不到 → 开关禁用，且请求体里**根本没有** enable_retry
 *
 * 运行：node .workbuddy/tmp/verify-chat-retry.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 9336
const MOCK_PORT = 8099
// 刻意避开 5173 / 5180：这两个端口上有非本会话的 node 进程长期占用
// （踩过：5173 是用户的 dev server，5180 是上一次验证脚本没退干净的 vite，
//   它们会让本次 vite 静默地启动失败，然后代理请求打到错的 target 上）
const APP_PORT = 5199
const APP = `http://127.0.0.1:${APP_PORT}`
const OUT = 'H:/work/rag-frontend/.workbuddy/shots'
mkdirSync(OUT, { recursive: true })

const NO_ANSWER = '知识库中没有找到与问题相关的内容，无法回答。'

/* ------------------------------------------------------------------ *
 * 一、脚本化 SSE 测试替身
 * ------------------------------------------------------------------ */

const mock = {
  /** GET /chat/options 报出的默认值 */
  retryDefault: false,
  /** 让 /chat/options 返回 500，验证前端的降级行为 */
  optionsFail: false,
  /** 记录每一次 /chat/stream 的请求体要点 */
  chatRequests: [],
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const mockServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`)
  const path = url.pathname

  if (path === '/__control') {
    const body = await readBody(req)
    if (body.retryDefault !== undefined) mock.retryDefault = body.retryDefault
    if (body.optionsFail !== undefined) mock.optionsFail = body.optionsFail
    if (body.clear) mock.chatRequests = []
    json(res, 200, { ok: true, mock })
    return
  }
  if (path === '/__requests') {
    json(res, 200, mock.chatRequests)
    return
  }

  if (path === '/api/v1/knowledge-bases') {
    json(res, 200, [
      {
        id: 'kb-verify',
        name: '联调测试库',
        description: '端到端验证用',
        doc_count: 2,
        created_at: '2026-10-14T10:00:00Z',
      },
    ])
    return
  }

  if (path === '/api/v1/chat/options') {
    if (mock.optionsFail) {
      json(res, 500, { code: 'internal_error', message: '能力清单不可用', detail: 'boom' })
      return
    }
    json(res, 200, {
      stream_retry_default: mock.retryDefault,
      stream_retry_max_attempts: 1,
      stream_events: ['retry', 'sources', 'delta', 'done', 'error'],
      non_stream_always_retries: true,
    })
    return
  }

  if (path === '/api/v1/chat/stream' && req.method === 'POST') {
    const body = await readBody(req)
    mock.chatRequests.push({
      question: body.question,
      // 「字段是否存在」与「值是什么」必须分开看：三态的核心就是"不发这个字段"
      hasEnableRetry: Object.prototype.hasOwnProperty.call(body, 'enable_retry'),
      enableRetry: body.enable_retry,
      historyLength: Array.isArray(body.history) ? body.history.length : -1,
    })

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    })
    // 与后端 `_sse_format` 逐字一致：event: X\ndata: {json}\n\n
    const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)

    if (body.enable_retry === true) {
      // 改写重试那一路：retry 事件在最前面，用来填住改写那 1~4 秒静默
      send('retry', { type: 'retry', attempt: 1, max_attempts: 1, reason: '首轮检索无可用片段，正在改写查询' })
      await delay(1200)
      send('sources', {
        type: 'sources',
        sources: [
          {
            doc_id: 'doc-1',
            filename: 'handbook.pdf',
            page: 3,
            chunk_index: 0,
            text: '建议把知识库切片控制在 300~500 字。',
            vector_score: 0.62,
            rerank_score: 5.155,
          },
        ],
      })
      for (const chunk of ['知识库切片建议 ', '控制在 300~500 字。']) {
        await delay(40)
        send('delta', { type: 'delta', content: chunk })
      }
      send('done', {
        type: 'done',
        answer: '知识库切片建议控制在 300~500 字。',
        refused: false,
        citations: [{ doc_id: 'doc-1', filename: 'handbook.pdf', page: 3, snippet: '建议把知识库切片控制在 300~500 字。' }],
        retried: true,
        attempts: 1,
        can_retry: false,
        query: '知识库切片字数建议',
      })
      res.end()
      return
    }

    // 首轮没找到：拒答，且额度没用满 → can_retry=true，前端据此弹「再找一次」
    await delay(60)
    send('sources', { type: 'sources', sources: [] })
    send('delta', { type: 'delta', content: NO_ANSWER })
    send('done', {
      type: 'done',
      answer: NO_ANSWER,
      refused: true,
      citations: [],
      retried: false,
      attempts: 0,
      can_retry: true,
      query: body.question,
    })
    res.end()
    return
  }

  json(res, 404, { code: 'not_found', message: `替身未实现：${req.method} ${path}` })
})

/* ------------------------------------------------------------------ *
 * 二、CDP 客户端（沿用项目里既有的验证脚本写法）
 * ------------------------------------------------------------------ */

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
      }, 60000)
    })
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    // Runtime.evaluate 抛异常不会让 CDP 调用 reject，必须显式查
    if (r.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description))
    }
    return r.result?.value
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
  }
}

async function waitFor(cdp, expression, label, timeout = 30000, step = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.evaluate(`!!(${expression})`)) return
    await delay(step)
  }
  throw new Error(`等待超时（${label}）: ${expression}`)
}

/* ------------------------------------------------------------------ *
 * 三、断言
 * ------------------------------------------------------------------ */

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`  ${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail ? `  ${detail}` : ''}`)
}

async function fetchJson(path) {
  const res = await fetch(`http://127.0.0.1:${MOCK_PORT}${path}`)
  return res.json()
}

async function control(payload) {
  const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/__control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

/** 在页面上填问题并发送 */
async function ask(cdp, question) {
  await cdp.evaluate(`(() => {
    const el = document.querySelector('.chat-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(question)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await delay(200)
  await cdp.evaluate(`document.querySelector('.chat-send-btn').click(); true`)
}

const READY_CHAT = `document.querySelector('.chat-input') && document.querySelector('.chat-retry-switch')?.innerText.includes('检索不到时改写重试')`

/** 等页面把知识库选中（kbId 就位），否则发出去会被前端自己挡掉 */
const KB_READY = `document.querySelector('.chat-header__right .ant-select')?.innerText.includes('联调测试库')`

async function openChat(cdp) {
  await cdp.send('Page.navigate', { url: `${APP}/chat` })
  await waitFor(cdp, READY_CHAT, '对话页就绪')
  await waitFor(cdp, KB_READY, '知识库已选中')
}

/* ------------------------------------------------------------------ *
 * 四、主流程
 * ------------------------------------------------------------------ */

let vite
let chrome
try {
  // ---- 起替身与 dev server ----
  await new Promise((resolve) => mockServer.listen(MOCK_PORT, '127.0.0.1', resolve))
  console.log(`替身已启动: http://127.0.0.1:${MOCK_PORT}`)

  // 直接跑 vite 的入口脚本，不经 npm 转发——否则 kill 掉的只是 npm 外壳，
  // vite 会留在端口上，下一次运行就会「静默地用了别人的 server」
  vite = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '--port',
      String(APP_PORT),
      '--host',
      '127.0.0.1',
      '--strictPort',
    ],
    {
      cwd: 'H:/work/rag-frontend',
      // 让 dev server 的 /api 代理指向替身，而不是真后端
      env: { ...process.env, VITE_PROXY_TARGET: `http://127.0.0.1:${MOCK_PORT}` },
      stdio: 'ignore',
    },
  )

  let viteReady = false
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${APP}/`)
      if (res.ok) {
        viteReady = true
        break
      }
    } catch {
      /* 未就绪 */
    }
    await delay(250)
  }
  if (!viteReady) throw new Error('Vite dev server 未就绪')

  // 确认代理确实指向替身。这一步不能省：端口被别人占着时，上面那个循环也会
  // 成功（200 来自另一个 server），只有这里的响应体能证伪。
  let proxied
  try {
    proxied = await (await fetch(`${APP}/api/v1/chat/options`)).json()
  } catch (error) {
    throw new Error(
      `代理到测试替身失败（很可能 ${APP_PORT} 被别的 server 占着，或替身没起来）: ${error.message}`,
    )
  }
  if (proxied?.stream_retry_default !== false) {
    throw new Error(`代理没有指向测试替身，拿到的是：${JSON.stringify(proxied)}`)
  }
  check('dev server 的 /api 代理已指向测试替身', true, JSON.stringify(proxied))

  // ---- 起 Chrome ----
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${CDP_PORT}`,
      '--proxy-server=direct://',
      '--proxy-bypass-list=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--window-size=1440,900',
      // 每次用新的 user-data-dir，避免残留上一次的登录态
      `--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/chrome-rag-retry-${Date.now()}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdpReady = false
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (res.ok) {
        cdpReady = true
        break
      }
    } catch {
      /* 未就绪 */
    }
    await delay(250)
  }
  if (!cdpReady) throw new Error('CDP 未就绪')

  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // 预置登录态（zustand persist 格式），省掉登录流程
  await cdp.send('Page.navigate', { url: `${APP}/login` })
  await delay(1200)
  await cdp.evaluate(`(() => {
    window.localStorage.clear(); window.sessionStorage.clear()
    window.localStorage.setItem('rag:auth', JSON.stringify({
      state: { token: 'verify-token', user: { id: 'u-verify', username: 'demo' } },
      version: 0,
    }))
    return true
  })()`)

  /* ================= A. 默认关：拒答 → 当场询问 → 再找一次 ================= */
  console.log('\n[A] 服务端默认 false → 开关关 → 拒答后当场询问')
  await control({ retryDefault: false, optionsFail: false, clear: true })
  await openChat(cdp)

  check(
    '开关初始状态跟随服务端默认值（false）',
    (await cdp.evaluate(`document.querySelector('.chat-retry-switch .ant-switch')?.getAttribute('aria-checked')`)) === 'false',
  )
  check(
    '开关可用（未因读不到能力清单而置灰）',
    (await cdp.evaluate(`!document.querySelector('.chat-retry-switch .ant-switch')?.classList.contains('ant-switch-disabled')`)) === true,
  )

  const Q1 = '知识库切片多大合适？'
  await ask(cdp, Q1)
  await waitFor(cdp, `document.querySelector('.chat-retry-hint')`, '「再找一次」提示', 30000)
  check('拒答后出现「再找一次」提示', true)
  check(
    '拒答的气泡有独立样式（不是普通回答）',
    (await cdp.evaluate(`!!document.querySelector('.chat-bubble--refused')`)) === true,
  )
  check(
    '提示文案说明了原因',
    (await cdp.evaluate(`document.querySelector('.chat-retry-hint__text')?.innerText ?? ''`)).includes('没检索到'),
  )
  await cdp.shot('18-chat-retry-prompt')

  let reqs = await fetchJson('/__requests')
  check('第一个请求：字段存在且值为 false（用户看得见开是关）', reqs[0]?.hasEnableRetry === true && reqs[0]?.enableRetry === false, JSON.stringify(reqs[0]))
  check('第一个请求：首轮没有历史（是第一问）', reqs[0]?.historyLength === 0, `history=${reqs[0]?.historyLength}`)

  const beforeCount = await cdp.evaluate(`document.querySelectorAll('.chat-message').length`)
  await cdp.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.chat-retry-hint__actions button'))
      .find((b) => b.innerText.replace(/\\s+/g, '').includes('再找一次'))
    if (!btn) throw new Error('没找到「再找一次」按钮')
    btn.click()
    return true
  })()`)

  // 改写那 1.2 秒里应当能看到「正在改写查询」，否则用户只会看到干等
  let sawNotice = false
  for (let i = 0; i < 40; i += 1) {
    const text = await cdp.evaluate(`document.querySelector('.chat-thinking')?.innerText ?? ''`)
    if (text.includes('改写')) {
      sawNotice = true
      break
    }
    await delay(50)
  }
  check('改写期间显示「正在改写查询后重新检索」', sawNotice, `拿到=「${await cdp.evaluate(`document.querySelector('.chat-thinking')?.innerText ?? ''`)}」`)

  await waitFor(
    cdp,
    `(document.querySelector('.chat-message--assistant .chat-bubble__text')?.innerText ?? '').includes('300~500') && !document.querySelector('.chat-thinking')`,
    '重试后的回答',
    30000,
  )
  check('重试后拿到回答', true)
  check('提示在重试后消失', (await cdp.evaluate(`!document.querySelector('.chat-retry-hint')`)) === true)
  check(
    '气泡数量没变（复用同一条消息，不是追加一条）',
    (await cdp.evaluate(`document.querySelectorAll('.chat-message').length`)) === beforeCount,
    `before=${beforeCount} after=${await cdp.evaluate(`document.querySelectorAll('.chat-message').length`)}`,
  )
  check(
    '显示改写溯源（拿什么去查的）',
    (await cdp.evaluate(`document.querySelector('.chat-retried')?.innerText ?? ''`)).includes('知识库切片字数建议'),
  )
  check(
    '重试后的引用来源渲染出来',
    (await cdp.evaluate(`document.querySelectorAll('.chat-reference').length`)) === 1,
  )

  reqs = await fetchJson('/__requests')
  check('第二个请求：显式带上了 enable_retry=true', reqs[1]?.enableRetry === true, JSON.stringify(reqs[1]))
  check('第二个请求：重发的是同一个问题', reqs[1]?.question === Q1, `question=${reqs[1]?.question}`)
  check(
    '第二个请求：history 里没有重复这一问',
    reqs[1]?.historyLength === 0,
    `history=${reqs[1]?.historyLength}`,
  )
  await cdp.shot('19-chat-retry-done')

  /* ================= B. 「不用了」收起提示 ================= */
  console.log('\n[B] 点「不用了」只收起提示，不改写拒答事实')
  await ask(cdp, '完全不相关的问题？')
  await waitFor(cdp, `document.querySelector('.chat-retry-hint')`, '第二次拒答提示', 30000)
  // 先记下"点之前"的请求数：这一阶段自己刚发过一问，拿绝对数量去断言会误判
  const reqsBeforeDismiss = (await fetchJson('/__requests')).length
  await cdp.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.chat-retry-hint__actions button'))
      .find((b) => b.innerText.replace(/\\s+/g, '').includes('不用了'))
    if (!btn) throw new Error('没找到「不用了」按钮')
    btn.click()
    return true
  })()`)
  await waitFor(cdp, `!document.querySelector('.chat-retry-hint')`, '提示收起')
  check('「不用了」后提示消失', true)
  check(
    '拒答样式与内容仍保留（不是把答案删了）',
    (await cdp.evaluate(`!!document.querySelector('.chat-bubble--refused')`)) === true,
  )
  reqs = await fetchJson('/__requests')
  check(
    '「不用了」不会发新请求（纯前端收起）',
    reqs.length === reqsBeforeDismiss,
    `before=${reqsBeforeDismiss} after=${reqs.length}`,
  )

  /* ================= C. 默认开：预设开关一次到位 ================= */
  console.log('\n[C] 服务端默认 true → 开关开 → 一次请求就走完改写重试')
  await control({ retryDefault: true, optionsFail: false, clear: true })
  await openChat(cdp)
  check(
    '开关初始状态跟随服务端默认值（true）',
    (await cdp.evaluate(`document.querySelector('.chat-retry-switch .ant-switch')?.getAttribute('aria-checked')`)) === 'true',
  )
  await ask(cdp, '开着开关问一次')
  await waitFor(
    cdp,
    `(document.querySelector('.chat-message--assistant .chat-bubble__text')?.innerText ?? '').includes('300~500')`,
    '开着开关的回答',
    30000,
  )
  check('开着开关：一次请求直接给出改写后的回答', true)
  check(
    '开着开关：不弹「再找一次」（额度已用掉，服务端 can_retry=false）',
    (await cdp.evaluate(`!document.querySelector('.chat-retry-hint')`)) === true,
  )
  reqs = await fetchJson('/__requests')
  check('请求带 enable_retry=true', reqs[0]?.enableRetry === true, JSON.stringify(reqs[0]))
  await cdp.shot('20-chat-retry-switch-on')

  /* ================= D. 显式 false 压过 true 的默认值 ================= */
  console.log('\n[D] 关掉开关（默认仍是 true）→ 请求必须是 false，不能退回默认')
  await control({ clear: true })
  await cdp.evaluate(`(() => {
    const sw = document.querySelector('.chat-retry-switch .ant-switch')
    if (!sw) throw new Error('没有开关')
    sw.click()
    return true
  })()`)
  await delay(300)
  check(
    '点击后开关变为关',
    (await cdp.evaluate(`document.querySelector('.chat-retry-switch .ant-switch')?.getAttribute('aria-checked')`)) === 'false',
  )
  await ask(cdp, '关掉开关问一次')
  await waitFor(cdp, `document.querySelector('.chat-retry-hint')`, '关掉开关后的拒答提示', 30000)
  reqs = await fetchJson('/__requests')
  check(
    '★ 显式 false 压过 true 的服务端默认值',
    reqs[0]?.hasEnableRetry === true && reqs[0]?.enableRetry === false,
    JSON.stringify(reqs[0]),
  )
  await cdp.shot('21-chat-retry-switch-off')

  /* ================= E. 读不到能力清单 → 不表态 ================= */
  console.log('\n[E] /chat/options 不可用 → 开关禁用，请求里根本没有 enable_retry')
  await control({ optionsFail: true, clear: true })
  await openChat(cdp)
  await waitFor(
    cdp,
    `document.querySelector('.chat-retry-switch .ant-switch')?.classList.contains('ant-switch-disabled')`,
    '开关置灰',
  )
  check('读不到能力清单时开关置灰（不猜默认值）', true)
  await ask(cdp, '读不到能力清单时问一次')
  await waitFor(cdp, `document.querySelector('.chat-retry-hint')`, '拒答提示', 30000)
  reqs = await fetchJson('/__requests')
  check(
    '★ 请求体里**没有** enable_retry 字段（未表态 → 服务端默认生效）',
    reqs[0]?.hasEnableRetry === false,
    JSON.stringify(reqs[0]),
  )
  check('仍未表态时服务端按默认拒答，提示照常出现', (await cdp.evaluate(`!!document.querySelector('.chat-retry-hint')`)) === true)
  await cdp.shot('22-chat-options-unavailable')

  console.log('\n未捕获的页面异常:', cdp.errors.length === 0 ? '无' : cdp.errors.slice(0, 3))
  if (cdp.errors.length > 0) {
    check('页面无未捕获异常', false, cdp.errors[0])
  }
} catch (error) {
  check(`流程中断：${error.message}`, false)
} finally {
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${'='.repeat(60)}`)
  console.log(`${failed === 0 ? '全部通过' : '存在失败'}（${results.length - failed}/${results.length}）`)
  if (failed > 0) {
    process.exitCode = 1
  }
  try {
    chrome?.kill()
  } catch {
    /* ignore */
  }
  try {
    vite?.kill()
  } catch {
    /* ignore */
  }
  mockServer.close()
  // 给子进程一点时间退出，避免端口残留
  await delay(500)
  process.exit(process.exitCode ?? 0)
}
