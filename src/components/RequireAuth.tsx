import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'

import { LOGIN_PATH, fetchCurrentUser, isApiError } from '../api'
import { isTokenExpired, useAuthStore } from '../store/auth'

/**
 * 路由守卫：两件事，顺序不能颠倒。
 *
 * 1. **有没有 token**（同步，无成本）——没有就直接去登录页，不必问后端。
 * 2. **token 还有没有效**（异步）——刷新页面后，localStorage 里的令牌可能
 *    早就过期、也可能被管理员停用。不校验的话，用户会先看到一整屏空列表，
 *    然后才被某个接口的 401 踢回登录页；而"看起来登录着、其实什么都没权限"
 *    比直接踢出去更让人困惑。
 *
 * 校验只在**首次挂载**时做一次（`useState` 记住"这个 token 验过了"），
 * 不做每次路由切换都验：那是白花一次往返，而且 401 拦截器已经能兜住
 * 后续任何时刻的失效。切换 token（重新登录）时会重新验。
 *
 * 校验失败的处理：
 *   - 401 → 清登录态 + 回登录页（带 redirect，登录后跳回原页面）
 *   - 网络错误 / 5xx → **不清登录态**，放行。
 *     后端临时挂了不代表令牌无效；此时把人踢去登录页，他连登录都登不上，
 *     只会更糟。让页面走各自的错误态，恢复后刷新即可。
 */
export default function RequireAuth() {
  const token = useAuthStore((state) => state.token)
  const expiresAt = useAuthStore((state) => state.expiresAt)
  const location = useLocation()

  /** 已经通过校验的 token 值；等于当前 token 说明本 token 验过了 */
  const [verifiedToken, setVerifiedToken] = useState<string | null>(null)
  /** 校验进行中（含"本地已判过期、等待清理"的瞬间） */
  const [checking, setChecking] = useState(false)

  const redirectTarget = `${location.pathname}${location.search}`

  useEffect(() => {
    if (!token) {
      setVerifiedToken(null)
      return
    }
    if (verifiedToken === token) {
      return
    }

    // 本地就能看出过期：省掉一次注定 401 的往返
    if (isTokenExpired(expiresAt)) {
      useAuthStore.getState().logout()
      return
    }

    let cancelled = false
    setChecking(true)

    fetchCurrentUser()
      .then((user) => {
        if (cancelled) {
          return
        }
        // 顺手把用户信息刷新一遍：可能是旧版本存下的、或管理员改过展示名
        useAuthStore.getState().setUser(user)
        setVerifiedToken(token)
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        if (isApiError(error) && error.status === 401) {
          // 令牌确实无效：清干净，下面的渲染分支会把人送去登录页
          useAuthStore.getState().logout()
          return
        }
        // 后端不可用 / 网络断了：不动登录态，放行让页面自己报错。
        // 记成"验过了"，避免后端一直挂着时每个页面切换都卡在校验上。
        setVerifiedToken(token)
      })
      .finally(() => {
        if (!cancelled) {
          setChecking(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [token, expiresAt, verifiedToken])

  if (!token) {
    const redirect = encodeURIComponent(redirectTarget)
    return <Navigate to={`${LOGIN_PATH}?redirect=${redirect}`} replace />
  }

  // 校验中先不渲染业务页：否则页面会带着"即将失效"的令牌发一堆请求，
  // 全部 401，用户看到连续的错误提示。
  if (checking) {
    return <AuthPending />
  }

  return <Outlet />
}

/** 校验令牌期间的占位。刻意做得安静：这是正常的启动流程，不是错误。 */
function AuthPending() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(0, 0, 0, 0.45)',
        fontSize: 14,
      }}
    >
      正在验证登录状态…
    </div>
  )
}
