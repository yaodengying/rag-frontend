import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { Alert, App as AntdApp, Button, Checkbox, Form, Input } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'

import { getErrorMessage, isCanceled, login } from '../../api'
import { useAuthStore } from '../../store/auth'
import { safeRedirect } from '../../utils/redirect'
import './login.css'

interface LoginFormValues {
  username: string
  password: string
  remember: boolean
}

export default function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { message } = AntdApp.useApp()

  const token = useAuthStore((state) => state.token)
  const redirect = safeRedirect(searchParams.get('redirect'))

  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  // 离开登录页时中断在途请求，避免组件卸载后回写状态
  useEffect(() => () => controllerRef.current?.abort(), [])

  // 已登录（例如用浏览器回退键退回来）就不必停在登录页
  if (token) {
    return <Navigate to={redirect} replace />
  }

  async function handleSubmit(values: LoginFormValues) {
    const controller = new AbortController()
    controllerRef.current = controller

    setSubmitting(true)
    setErrorMessage(null)

    try {
      const result = await login(
        { username: values.username.trim(), password: values.password },
        { signal: controller.signal },
      )

      // 写入全局登录态，token 由 persist 中间件落到本地存储。
      // expiresAt 一并存下：刷新页面后能本地识别"肯定已过期"，省一次注定 401 的往返。
      useAuthStore.getState().login(result.token, result.user, {
        remember: values.remember,
        expiresAt: result.expiresAt,
      })

      void message.success('登录成功')
      navigate(redirect, { replace: true })
    } catch (error) {
      // 组件卸载时中断在途请求，取消不算登录失败
      if (!isCanceled(error)) {
        setErrorMessage(getErrorMessage(error))
      }
    } finally {
      setSubmitting(false)
      controllerRef.current = null
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <header className="login-header">
          <div className="login-logo" aria-hidden="true">
            RAG
          </div>
          <h1 className="login-title">知识库问答系统</h1>
          <p className="login-subtitle">请登录后开始使用</p>
        </header>

        {errorMessage && (
          <Alert
            className="login-alert"
            type="error"
            showIcon
            message={errorMessage}
            closable
            onClose={() => setErrorMessage(null)}
          />
        )}

        <Form<LoginFormValues>
          layout="vertical"
          size="large"
          requiredMark={false}
          initialValues={{ remember: true }}
          disabled={submitting}
          onFinish={handleSubmit}
          onValuesChange={() => {
            if (errorMessage) {
              setErrorMessage(null)
            }
          }}
        >
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              prefix={<UserOutlined />}
              placeholder="请输入用户名"
              autoComplete="username"
              autoFocus
              allowClear
            />
          </Form.Item>

          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="请输入密码"
              autoComplete="current-password"
            />
          </Form.Item>

          <div className="login-row">
            <Form.Item name="remember" valuePropName="checked" noStyle>
              <Checkbox>记住我</Checkbox>
            </Form.Item>
          </div>

          <Form.Item className="login-submit">
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登 录
            </Button>
          </Form.Item>
        </Form>

        <p className="login-footer">登录状态保存在本地，勾选「记住我」可跨会话保持</p>
      </div>
    </div>
  )
}
