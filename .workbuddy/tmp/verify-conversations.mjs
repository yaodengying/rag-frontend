/**
 * 端到端验证：多轮对话历史迁移到服务端 Redis（真后端）。
 *
 * 前置：8010 端口有**新代码**的 rag-backend（REDIS_URL 已配置、Milvus 就绪）。
 * 覆盖：
 *   A. 首问请求体不带 conversation_id；回答后左侧会话列表出现该会话（服务端落库）
 *   B. 续问请求体带 conversation_id 且**不带 history**（历史由服务端 Redis 供）
 *   C. 刷新页面 → 从左侧打开历史会话 → 消息与溯源（文件名 + 页码）完整还原
 *   D. 历史会话上继续提问仍带同一 conversation_id（会话续上了）
 *
 * 运行：node .workbuddy/tmp/verify-conversations.mjs   （8010 后端须先起）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CDP_PORT = 9338
// 刻意避开 5173/5180/5199：这些端口上有非本会话或历史遗留的 node 进程
const APP_PORT = 5211
const APP = `http://127.0.0.1:${APP_PORT}`
const BACKEND = 'http://127.0.0.1:8010'
const OUT = 'H:/work/rag-frontend/.workbuddy/shots'
mkdirSync(OUT, { recursive: true })

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.seq = 0
    this.waiters = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('ws 失败')))
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
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
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
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

async function waitFor(cdp, expression, label, timeout = 40000, step = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.evaluate(`!!(${expression})`)) return
    await delay(step)
  }
  throw new Error(`等待超时（${label}）: ${expression}`)
}

/**
 * 「最后一条助手消息已出文本且收尾」的可证伪信号。
 *
 * 必须**按消息定位**再取它自己的文本 span：对全部 `.chat-bubble__text` 取
 * pop 会在最后一条气泡还没文本（拒答/出错/流式刚开始）时拿到上一条的
 * 内容——上一次运行就是被这个假通过坑的（B 组在 Q2 实际挂掉时判了 ok）。
 * 连同全局「不在流式中」一起判断，防止把生成中的半截文本当成完成。
 */
function lastAssistantDone(minLength) {
  const bubbles = `Array.from(document.querySelectorAll('.chat-message--assistant'))`
  const last = `${bubbles}[${bubbles}.length - 1]`
  return (
    `${bubbles}.length >= 1 && ` +
    `(${last}?.querySelector('.chat-bubble__text--streaming') === null) && ` +
    `(${last}?.querySelector('.chat-bubble__text')?.innerText ?? '').length >= ${minLength}`
  )
}

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`  ${ok ? '[ok]  ' : '[FAIL]'} ${label}${detail ? `  ${detail}` : ''}`)
}

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

const READY_CHAT = `document.querySelector('.chat-input')`
const KB_READY = `!!document.querySelector('.chat-header__right .ant-select')`

let vite
let chrome
try {
  // ---- 确认真后端在跑 ----
  const ready = await fetch(`${BACKEND}/api/v1/ready`)
    .then((r) => r.json())
    .catch(() => null)
  if (!ready || ready.status !== 'ready') {
    throw new Error(`8010 后端未就绪（${JSON.stringify(ready)}）——先起新代码实例`)
  }
  console.log('后端已就绪:', JSON.stringify(ready.checks))

  // ---- 起 vite（/api 代理指向 8010）----
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
      env: { ...process.env, VITE_PROXY_TARGET: BACKEND },
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

  // 代理指向真后端的可证伪检查：/chat/options 的形状只有真后端会给全
  const proxied = await (await fetch(`${APP}/api/v1/chat/options`)).json()
  check(
    'dev server 的 /api 代理指向 8010 真后端',
    typeof proxied?.stream_retry_default === 'boolean' && Array.isArray(proxied?.stream_events),
    JSON.stringify(proxied),
  )

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
      `--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/chrome-rag-conv-${Date.now()}`,
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

  // 每次新文档加载前都装上 fetch 记录器：抓 /chat/stream 的请求体要点。
  // 必须用 addScriptToEvaluateOnNewDocument，导航后手装就晚了（app 已发过请求）。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__chatReqs = []
      const orig = window.fetch.bind(window)
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || ''
          if (url.includes('/chat/stream') && init && typeof init.body === 'string') {
            const body = JSON.parse(init.body)
            window.__chatReqs.push({
              hasConversationId: 'conversation_id' in body,
              conversationId: body.conversation_id ?? null,
              hasHistory: 'history' in body,
              historyLength: Array.isArray(body.history) ? body.history.length : null,
              question: body.question,
            })
          }
        } catch {}
        return orig(input, init)
      }
    `,
  })

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

  /* ================= A. 首问：不带 conversation_id，回答后落库出列表 ================= */
  console.log('\n[A] 首问 → 服务端生成会话 ID → 左侧列表出现该会话')
  await cdp.send('Page.navigate', { url: `${APP}/chat` })
  await waitFor(cdp, READY_CHAT, '对话页就绪')
  await waitFor(cdp, KB_READY, '知识库下拉就绪')
  await delay(500)

  const Q1 = '制定交易计划的顺序是什么？'
  await ask(cdp, Q1)
  await waitFor(cdp, lastAssistantDone(20), '第一问的回答', 120000)
  // 给 Q1 那条 SSE 的「客户端主动断开」留出收尾时间：Chrome 会复用刚被
  // abort 的 keep-alive 连接，立刻发下一条流式请求时响应可能整个丢失
  // （实测：Q2 的请求到了后端、检索重排都跑了，但响应头永远没回到浏览器）
  await delay(2000)
  check('首问拿到回答（真检索 + 真生成）', true)

  let reqs = await cdp.evaluate(`window.__chatReqs`)
  check(
    '首问请求体不带 conversation_id（由服务端生成）',
    reqs.length === 1 && reqs[0].hasConversationId === false,
    JSON.stringify(reqs),
  )
  check('首问请求体带 history（兜底路径，空数组）', reqs[0]?.hasHistory === true, JSON.stringify(reqs[0]))

  // 左侧会话列表出现这一问（服务端 done 已落库，前端轮询刷新）
  await waitFor(
    cdp,
    `Array.from(document.querySelectorAll('.chat-side__item-title')).some((el) => el.innerText.includes('制定交易计划'))`,
    '左侧会话列表出现新会话',
    20000,
  )
  check('会话已落库并出现在左侧列表（标题取首问）', true)
  await cdp.shot('22-conv-first-turn')

  /* ================= B. 续问：带 conversation_id 且不带 history ================= */
  console.log('\n[B] 续问 → 请求带 conversation_id、不带 history')
  const Q2 = '上面一共列了几步？'
  await ask(cdp, Q2)
  await waitFor(cdp, lastAssistantDone(5), '第二问的回答', 120000)
  await delay(2000)
  reqs = await cdp.evaluate(`window.__chatReqs`)
  check(
    '续问请求体带 conversation_id（同一会话）',
    reqs.length === 2 && reqs[1].hasConversationId === true && typeof reqs[1].conversationId === 'string',
    JSON.stringify(reqs[1]),
  )
  const convId2 = reqs[1]?.conversationId
  check(
    '续问请求体**不发 history**（历史真相源在服务端 Redis）',
    reqs[1]?.hasHistory === false,
    JSON.stringify(reqs[1]),
  )

  /* ================= C. 刷新 → 打开历史会话 → 消息与溯源还原 ================= */
  console.log('\n[C] 刷新后从左侧打开历史会话，溯源（文件名+页码）还原')
  await cdp.send('Page.navigate', { url: `${APP}/chat` })
  await waitFor(cdp, READY_CHAT, '对话页重新就绪')
  await waitFor(
    cdp,
    `Array.from(document.querySelectorAll('.chat-side__item-title')).some((el) => el.innerText.includes('制定交易计划'))`,
    '刷新后左侧会话列表（服务端数据）',
    20000,
  )
  check('刷新后会话列表来自服务端（localStorage 已清过）', true)

  // 列表按最近更新倒序 → 第一项就是本轮刚聊的那个会话（含 Q1+Q2 两轮）。
  // 不能按标题找：历史运行留下过同名会话，按标题会点进旧的。
  await cdp.evaluate(`(() => {
    const item = document.querySelector('.chat-side__item')
    if (!item) throw new Error('会话列表为空')
    item.click()
    return true
  })()`)
  await waitFor(
    cdp,
    `document.querySelectorAll('.chat-message').length >= 4 && !document.querySelector('.chat-bubble__text--streaming')`,
    '历史消息灌进页面',
    20000,
  )
  const msgCount = await cdp.evaluate(`document.querySelectorAll('.chat-message').length`)
  check('历史消息完整还原（4 条 = 两轮问答）', msgCount === 4, `count=${msgCount}`)
  const pageCount = await cdp.evaluate(
    `Array.from(document.querySelectorAll('.chat-reference__page')).map((el) => el.innerText)`,
  )
  check(
    '溯源页码在历史回放里可见（第N页）',
    Array.isArray(pageCount) && pageCount.some((t) => /第\d+页/.test(t ?? '')),
    JSON.stringify(pageCount),
  )
  const refTitle = await cdp.evaluate(
    `document.querySelector('.chat-reference__name')?.innerText ?? ''`,
  )
  check('溯源文件名在历史回放里可见', (refTitle ?? '').includes('短线操作模式'), refTitle)
  await cdp.shot('23-conv-history-replay')

  /* ================= D. 历史会话上继续提问仍续同一会话 ================= */
  console.log('\n[D] 历史会话上继续提问，会话 ID 延续')
  const Q3 = '用一句话概括这些步骤的作用。'
  await ask(cdp, Q3)
  await waitFor(cdp, lastAssistantDone(5), '第三问的回答', 120000)
  await delay(2000)
  reqs = await cdp.evaluate(`window.__chatReqs`)
  // 刷新后 addScriptToEvaluateOnNewDocument 重新装记录器，__chatReqs 已清零——
  // 所以 Q3 是**新数组**的第 0 条；会话 ID 要与 B 组记下的 convId2 对比
  check(
    '历史会话续聊仍带同一 conversation_id',
    reqs.length === 1 && reqs[0].hasConversationId === true && reqs[0].conversationId === convId2,
    `B组=${convId2} 刷新后=${JSON.stringify(reqs)}`,
  )
  check('历史续聊同样不发 history', reqs[0]?.hasHistory === false)
  await cdp.shot('24-conv-continue')

  /* ================= 汇总 ================= */
  console.log('\n' + '='.repeat(50))
  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.log(`存在 ${failed.length} 项失败：`)
    for (const r of failed) console.log('  - ' + r.label)
    process.exitCode = 1
  } else {
    console.log(`全部通过（${results.length} 项）`)
  }
} catch (error) {
  console.error('验证中断:', error.message)
  process.exitCode = 1
} finally {
  try {
    vite?.kill()
  } catch {}
  try {
    chrome?.kill()
  } catch {}
}
