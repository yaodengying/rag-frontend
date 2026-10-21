import { useAuthStore } from '../store/auth'

/** 登录页路径 */
export const LOGIN_PATH = '/login'

/** 401 时广播的事件名，路由层可监听它做无刷新跳转 */
export const UNAUTHORIZED_EVENT = 'auth:unauthorized'

/**
 * 未接入前端路由时的兜底开关：401 后是否用 `window.location` 整页跳转登录页。
 * 接入路由后由 `setUnauthorizedHandler` 提供无刷新跳转，本开关不再生效。
 */
export const REDIRECT_TO_LOGIN_ON_401 = true

/**
 * 由路由层注入的跳转实现（见 `RootLayout`）。
 * 抽成可注入的回调，是为了让请求层不依赖路由库——它只需知道「有人能处理跳转」。
 */
let redirectHandler: (() => void) | null = null

/** 注册 / 注销未授权跳转处理器，传入 null 表示注销 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  redirectHandler = handler
}

/** 并发 401 时只跳转一次 */
let redirecting = false

/**
 * 统一的鉴权失效处理：清登录态 → 广播事件 → 跳转登录页。
 * axios 拦截器与 SSE 客户端共用，保证两条链路的 401 行为一致。
 */
export function handleUnauthorized(): void {
  useAuthStore.getState().logout()
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))

  if (redirecting) {
    return
  }

  // 已在登录页就无需再跳，只做状态清理
  const { pathname, search, hash } = window.location
  if (pathname === LOGIN_PATH) {
    return
  }

  // 优先走前端路由（无刷新）；没有注册处理器时退回整页跳转
  if (redirectHandler) {
    redirecting = true
    window.setTimeout(() => {
      redirecting = false
    }, 1500)
    redirectHandler()
    return
  }

  if (!REDIRECT_TO_LOGIN_ON_401) {
    return
  }

  redirecting = true
  window.setTimeout(() => {
    redirecting = false
  }, 1500)

  const redirect = encodeURIComponent(`${pathname}${search}${hash}`)
  window.location.replace(`${LOGIN_PATH}?redirect=${redirect}`)
}
