import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import {
  BellOutlined,
  BookOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  SearchOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { App as AntdApp, Avatar, Button, Dropdown, Input, Tooltip } from 'antd'

import { logout } from '../api'
import { useAuthStore } from '../store/auth'
import './app-layout.css'

/**
 * 登录后的应用外壳：左侧导航 + 顶栏 + 内容区。
 * 布局与配色对齐产品原型（知识库管理平台）。
 */

const NAV_ITEMS = [
  { to: '/knowledge-base', icon: <BookOutlined />, label: '知识库管理' },
  { to: '/documents', icon: <FileTextOutlined />, label: '文档管理' },
  { to: '/chat', icon: <MessageOutlined />, label: '智能问答' },
  { to: '/conversations', icon: <HistoryOutlined />, label: '对话历史' },
] as const

export default function AppLayout() {
  const navigate = useNavigate()
  const { message } = AntdApp.useApp()
  const user = useAuthStore((state) => state.user)
  const [collapsed, setCollapsed] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const username = user?.username || '管理员'

  async function handleLogout() {
    setLoggingOut(true)
    try {
      await logout()
    } finally {
      useAuthStore.getState().logout()
      setLoggingOut(false)
      void message.success('已退出登录')
      navigate('/login', { replace: true })
    }
  }

  return (
    <div className={`app-shell${collapsed ? ' app-shell--collapsed' : ''}`}>
      <aside className="app-sidebar">
        <div className="app-logo">
          <span className="app-logo__mark" aria-hidden="true">
            <BookOutlined />
          </span>
          <span className="app-logo__text">
            <strong>知识库管理平台</strong>
            <small>Knowledge Base</small>
          </span>
        </div>

        <nav className="app-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `app-nav__item${isActive ? ' app-nav__item--active' : ''}`}
              title={item.label}
            >
              <span className="app-nav__icon">{item.icon}</span>
              <span className="app-nav__label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="app-main">
        <header className="app-topbar">
          <div className="app-topbar__left">
            <Button
              type="text"
              className="app-topbar__toggle"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
              aria-label="切换侧边栏"
            />
            <Input
              className="app-topbar__search"
              placeholder="搜索知识库、文档..."
              prefix={<SearchOutlined className="app-topbar__search-icon" />}
              allowClear
              onPressEnter={(event) => {
                const keyword = event.currentTarget.value.trim()
                if (!keyword) {
                  return
                }
                // 全局搜索先落到文档页，后续有独立搜索结果页时再换这里
                navigate(`/documents?keyword=${encodeURIComponent(keyword)}`)
              }}
            />
          </div>

          <div className="app-topbar__right">
            <Tooltip title="通知">
              <Button type="text" className="app-topbar__icon-btn" icon={<BellOutlined />} />
            </Tooltip>
            <div className="app-topbar__divider" />
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: '退出登录',
                    onClick: () => void handleLogout(),
                  },
                ],
              }}
            >
              <button type="button" className="app-topbar__user" disabled={loggingOut}>
                <Avatar size={28} icon={<UserOutlined />} className="app-topbar__avatar" />
                <span className="app-topbar__username">{username}</span>
              </button>
            </Dropdown>
          </div>
        </header>

        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
