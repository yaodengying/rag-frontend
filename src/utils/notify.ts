/**
 * 全局提示的可插拔出口。
 *
 * 请求层不直接依赖 antd —— 由 UI 层（`AntdNotifierBridge`）把 antd 的
 * message 实例注册进来。好处：
 *  1. 请求层可以在 React 之外使用，也便于单测；
 *  2. 走 `App.useApp()` 拿到的 message 实例能正确消费 ConfigProvider 的
 *     主题与语言配置，避免 antd 静态方法丢失 context 的问题。
 */

export interface Notifier {
  error: (content: string) => void
}

let notifier: Notifier | null = null

/** 短时间内内容相同的错误只提示一次，避免并发请求同时 401 时刷屏 */
const DEDUPE_WINDOW_MS = 1500
let lastMessage = ''
let lastAt = 0

export function registerNotifier(next: Notifier | null): void {
  notifier = next
}

export function notifyError(content: string): void {
  const now = Date.now()
  if (content === lastMessage && now - lastAt < DEDUPE_WINDOW_MS) {
    return
  }
  lastMessage = content
  lastAt = now

  if (notifier) {
    notifier.error(content)
  } else {
    // 桥接组件尚未挂载（例如应用启动瞬间的请求），先落控制台，不丢信息
    console.error('[api]', content)
  }
}
