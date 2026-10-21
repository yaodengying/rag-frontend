import { useNavigate } from 'react-router'
import { Button, Result } from 'antd'

/** 404 页。放在路由守卫内部，因此只有已登录用户会看到 */
export default function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <Result
      status="404"
      title="404"
      subTitle="抱歉，你访问的页面不存在。"
      extra={
        <Button type="primary" onClick={() => navigate('/', { replace: true })}>
          返回首页
        </Button>
      }
    />
  )
}
