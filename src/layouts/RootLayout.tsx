import { useEffect } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'

import { LOGIN_PATH, setUnauthorizedHandler } from '../api'

/**
 * 应用外壳：渲染子路由，并把「鉴权失效」接到前端路由上。
 *
 * 请求层在 401 时只负责广播意图，具体怎么跳由这里决定——所以 token 失效是
 * 无刷新跳转到登录页，而不是整页重载。放在布局层可保证整个应用只注册一次。
 */
export default function RootLayout() {
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    setUnauthorizedHandler(() => {
      const redirect = encodeURIComponent(`${location.pathname}${location.search}`)
      navigate(`${LOGIN_PATH}?redirect=${redirect}`, { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate, location])

  return <Outlet />
}
