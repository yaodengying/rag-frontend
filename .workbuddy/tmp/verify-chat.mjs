import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9334
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
      /* 未就绪 */
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

try {
  await waitForCdp()
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const cdp = new CDP(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // 复用同一 user-data-dir 时会残留上一次的登录态，先把本地存储清空再进登录页
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

  // ---------- 问答页 ----------
  await cdp.send('Page.navigate', { url: `${APP}/chat` })
  await sleep(2500)
  console.log('  顶栏文本:', JSON.stringify(await cdp.evaluate(`document.querySelector('.chat-header')?.innerText.replace(/\\s+/g,' ')`)))

  // 展开知识库下拉，选「联调测试库」
  // 注意：antd v6 把 Select 的 .ant-select-selector 改成了 .ant-select-content，触发用外层 .ant-select 最稳
  await cdp.evaluate(
    `document.querySelector('.chat-header__right .ant-select').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`,
  )
  await waitFor(cdp, `document.querySelectorAll('.ant-select-item-option').length > 0`, '下拉选项')
  const options = await cdp.evaluate(
    `Array.from(document.querySelectorAll('.ant-select-item-option')).map(e => e.innerText)`,
  )
  console.log('  下拉选项:', JSON.stringify(options))
  await cdp.evaluate(`(() => {
    const target = Array.from(document.querySelectorAll('.ant-select-item-option'))
      .find(e => e.innerText.includes('联调测试库'))
    if (!target) throw new Error('下拉里没有「联调测试库」')
    for (const type of ['mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true }))
    }
    return true
  })()`)
  await sleep(800)
  console.log('  切换后顶栏:', JSON.stringify(await cdp.evaluate(`document.querySelector('.chat-header')?.innerText.replace(/\\s+/g,' ')`)))

  // 提问
  await cdp.evaluate(`(() => {
    const el = document.querySelector('.chat-input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '知识库切片是什么？推荐多大？')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
  await cdp.evaluate(`document.querySelector('.chat-send-btn').click(); true`)

  await waitFor(
    cdp,
    `(document.querySelector('.chat-message--assistant .chat-bubble__text')?.innerText?.length ?? 0) > 0 && !document.querySelector('.chat-bubble__text--streaming')`,
    '回答完成',
    180000,
  )
  const answer = await cdp.evaluate(
    `document.querySelector('.chat-message--assistant .chat-bubble__text')?.innerText ?? ''`,
  )
  const refs = await cdp.evaluate(
    `Array.from(document.querySelectorAll('.chat-reference')).map(e => e.innerText.replace(/\\s+/g,' ').trim())`,
  )
  console.log('  回答:', answer.replace(/\s+/g, ' ').slice(0, 200))
  console.log('  引用卡片:', JSON.stringify(refs))
  await cdp.shot('07-chat-with-refs')

  console.log('  未捕获异常:', cdp.errors.length === 0 ? '无' : cdp.errors.slice(0, 3))
} catch (error) {
  console.error('验证失败:', error.message)
  process.exitCode = 1
} finally {
  chrome.kill()
}
