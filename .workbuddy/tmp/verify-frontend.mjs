import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const APP = 'http://127.0.0.1:5180'
const OUT = 'H:/work/rag-frontend/.workbuddy/shots'
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
    '--window-size=1440,900',
    '--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/chrome-rag-verify',
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
      /* 还没起来 */
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
    this.consoleErrors = []
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(
          '未捕获异常: ' + (msg.params.exceptionDetails?.exception?.description ?? ''),
        )
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
      }, 90000)
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
    console.log(`  截图 -> ${OUT}/${name}.png`)
  }
}

async function waitFor(cdp, expression, label, timeout = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await cdp.evaluate(`!!(${expression})`)) return
    await sleep(300)
  }
  throw new Error(`等待超时（${label}）: ${expression}`)
}

try {
  await waitForCdp()
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // ---------- 1. 登录页 ----------
  await cdp.send('Page.navigate', { url: `${APP}/login` })
  await waitFor(cdp, `document.querySelector('#username')`, '登录表单')
  await cdp.shot('01-login')

  await cdp.evaluate(`(() => {
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setValue(document.querySelector('#username'), 'demo')
    setValue(document.querySelector('#password'), 'demo123456')
    return true
  })()`)
  await cdp.evaluate(`document.querySelector('button[type=submit]').click(); true`)

  await waitFor(cdp, `location.pathname !== '/login'`, '登录跳转')
  console.log('  登录后路径:', await cdp.evaluate('location.pathname + location.search'))
  console.log('  本地 token 前缀:', await cdp.evaluate(
    `JSON.parse(localStorage.getItem('rag:auth') || sessionStorage.getItem('rag:auth') || '{}').state?.token?.slice(0, 18) ?? '(无)'`,
  ))
  await sleep(1200)
  await cdp.shot('02-knowledge-base')

  // ---------- 2. 知识库列表是否渲染出真实后端数据 ----------
  await waitFor(cdp, `document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length > 0`, '知识库表格')
  const kbRows = await cdp.evaluate(
    `Array.from(document.querySelectorAll('.ant-table-tbody tr.ant-table-row')).map(tr => tr.innerText.replace(/\\s+/g,' ').trim())`,
  )
  console.log('  知识库行:', JSON.stringify(kbRows))

  // ---------- 3. 文档页 ----------
  await cdp.send('Page.navigate', { url: `${APP}/documents` })
  await sleep(2500)
  await waitFor(cdp, `document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length > 0`, '文档表格')
  const docRows = await cdp.evaluate(
    `Array.from(document.querySelectorAll('.ant-table-tbody tr.ant-table-row')).map(tr => tr.innerText.replace(/\\s+/g,' ').trim())`,
  )
  console.log('  文档行:', JSON.stringify(docRows))
  await cdp.shot('03-documents')

  // ---------- 4. 问答页 ----------
  await cdp.send('Page.navigate', { url: `${APP}/chat` })
  await sleep(2500)
  const kbSelected = await cdp.evaluate(
    `document.querySelector('.chat-header__right .ant-select-selection-item')?.innerText ?? '(未选中)'`,
  )
  console.log('  问答页选中的知识库:', kbSelected)
  await cdp.shot('04-chat')

  // ---------- 5. 发一条问题，验证流式回答 ----------
  await cdp.evaluate(`(() => {
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setValue(document.querySelector('.chat-input'), '知识库切片是什么？')
    return true
  })()`)
  await sleep(300)
  await cdp.evaluate(`document.querySelector('.chat-send-btn').click(); true`)
  await waitFor(cdp, `document.querySelectorAll('.chat-message--assistant .chat-bubble__text').length > 0`, '助手回答', 90000)
  await waitFor(
    cdp,
    `!document.querySelector('.chat-bubble__text--streaming')`,
    '流式结束',
    120000,
  )
  const answer = await cdp.evaluate(
    `document.querySelector('.chat-message--assistant .chat-bubble__text')?.innerText ?? ''`,
  )
  const refs = await cdp.evaluate(
    `Array.from(document.querySelectorAll('.chat-reference__name')).map(e => e.innerText)`,
  )
  console.log('  回答:', answer.slice(0, 120))
  console.log('  引用来源:', JSON.stringify(refs))
  const historySaved = await cdp.evaluate(
    `Object.keys(JSON.parse(localStorage.getItem('rag:conversations') || '{}')).length`,
  )
  console.log('  本地会话数:', historySaved)
  await cdp.shot('05-chat-answer')

  // ---------- 6. 对话历史页 ----------
  await cdp.send('Page.navigate', { url: `${APP}/conversations` })
  await sleep(1800)
  const convCards = await cdp.evaluate(
    `Array.from(document.querySelectorAll('.conv-card__title')).map(e => e.innerText)`,
  )
  console.log('  历史会话卡片:', JSON.stringify(convCards))
  await cdp.shot('06-conversations')

  if (cdp.consoleErrors.length > 0) {
    console.log('\n  控制台错误:')
    for (const line of cdp.consoleErrors.slice(0, 10)) console.log('   -', line.slice(0, 200))
  } else {
    console.log('\n  控制台无错误')
  }
} catch (error) {
  console.error('验证失败:', error.message)
  process.exitCode = 1
} finally {
  chrome.kill()
}
