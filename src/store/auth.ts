import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { StateStorage } from 'zustand/middleware'

export interface AuthUser {
  id: string
  username: string
  /** 展示名（后端字段 display_name），取不到时等于 username */
  displayName?: string
  [key: string]: unknown
}

export interface LoginStateOptions {
  /**
   * 是否持久化登录态（登录页的「记住我」）。
   * true → localStorage，关掉浏览器仍在；false → sessionStorage，关闭标签页即失效。
   */
  remember?: boolean
  /**
   * 令牌过期时刻（毫秒时间戳）。后端 `expires_at` 是权威来源；
   * 拿不到时留空，此时只能靠 `/auth/me` 或业务接口的 401 判断。
   */
  expiresAt?: number | null
}

export interface AuthState {
  token: string | null
  user: AuthUser | null
  /**
   * 令牌过期时刻（毫秒时间戳），null 表示未知。
   *
   * 用途只是**省一次网络往返**：本地能看出肯定过期了，就不必先请求再收 401。
   * 反过来「本地觉得没过期」并不代表有效（可能被服务端作废），
   * 所以真实判据永远是服务端的 401——别把这里的判断当成安全边界。
   */
  expiresAt: number | null
  /** 登录成功后写入 token（及可选的用户信息） */
  login: (token: string, user?: AuthUser | null, options?: LoginStateOptions) => void
  setToken: (token: string | null) => void
  setUser: (user: AuthUser | null) => void
  /** 清除登录态，退出登录与 401 拦截都会调用 */
  logout: () => void
}

export const AUTH_STORAGE_KEY = 'rag:auth'

/**
 * 当前使用的存储介质。默认「记住我」，
 * 读取时会被实际命中的介质（local / session）纠正，刷新页面后策略不会漂移。
 */
let useLocalStorage = true

/**
 * 双介质存储：读的时候两边都看，写的时候只写其中一边并清掉另一边，
 * 这样「记住我」在刷新后依然生效，也不会出现旧数据被优先读到。
 */
const hybridStorage: StateStorage = {
  getItem: (name) => {
    const local = localStorage.getItem(name)
    if (local !== null) {
      useLocalStorage = true
      return local
    }
    const session = sessionStorage.getItem(name)
    if (session !== null) {
      useLocalStorage = false
      return session
    }
    return null
  },
  setItem: (name, value) => {
    const target = useLocalStorage ? localStorage : sessionStorage
    const other = useLocalStorage ? sessionStorage : localStorage
    target.setItem(name, value)
    other.removeItem(name)
  },
  removeItem: (name) => {
    localStorage.removeItem(name)
    sessionStorage.removeItem(name)
  },
}

/**
 * 鉴权状态。持久化到 localStorage / sessionStorage，刷新页面后仍保持登录。
 *
 * 请求拦截器通过 `useAuthStore.getState()` 读取 token，
 * 因此本文件**不能**反向 import 请求层，否则会形成循环依赖。
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      expiresAt: null,
      login: (token, user = null, options = {}) => {
        // 必须在 set 之前切换介质，persist 是在 set 里同步写盘的
        if (options.remember !== undefined) {
          useLocalStorage = options.remember
        }
        set({ token, user, expiresAt: options.expiresAt ?? null })
      },
      setToken: (token) => set({ token }),
      setUser: (user) => set({ user }),
      logout: () => set({ token: null, user: null, expiresAt: null }),
    }),
    {
      name: AUTH_STORAGE_KEY,
      storage: createJSONStorage(() => hybridStorage),
      // 只持久化数据字段，函数不需要落盘
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        expiresAt: state.expiresAt,
      }),
    },
  ),
)

/**
 * 本地粗判：令牌是否已过期。
 *
 * 只认「确定过期」：`expiresAt` 未知（旧版本留下的登录态、后端没给过期时刻）
 * 一律当作**未过期**，让它走到服务端再判定。
 *
 * 为什么留 30 秒余量：`expiresAt` 判的是"现在这一秒"，而请求到达服务端还要
 * 几十到几百毫秒。不留余量会出现"本地判断有效 → 请求到后端刚好过期 → 401"
 * 的抖动，用户看到的是随机被踢。宁可在临界期多问一次 `/auth/me`。
 */
const EXPIRY_SKEW_MS = 30_000

export function isTokenExpired(
  expiresAt: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return false
  }
  return expiresAt - EXPIRY_SKEW_MS <= now
}
