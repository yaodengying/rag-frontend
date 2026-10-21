import { Navigate, createBrowserRouter } from 'react-router'

import RequireAuth from '../components/RequireAuth'
import AppLayout from '../layouts/AppLayout'
import RootLayout from '../layouts/RootLayout'
import ChatPage from '../pages/Chat'
import ConversationsPage from '../pages/Conversations'
import DocumentsPage from '../pages/Documents'
import KnowledgeBasePage from '../pages/KnowledgeBase'
import LoginPage from '../pages/Login'
import NotFoundPage from '../pages/NotFound'

/**
 * 路由表。
 *
 * 结构：RootLayout（外壳，挂 401 跳转）
 *        ├─ /login          公开
 *        └─ RequireAuth     守卫：无 token → 登录页；有 token → 先向 /auth/me 验一次
 *             └─ AppLayout  应用外壳（侧边导航 + 顶栏）
 *                  ├─ /                 → 重定向到 /knowledge-base
 *                  ├─ /knowledge-base   知识库管理
 *                  ├─ /documents        文档管理
 *                  ├─ /chat             智能问答
 *                  ├─ /conversations    对话历史
 *                  └─ *                 404
 *
 * 两条约定：
 *   - **新页面挂在 RequireAuth 之下**。挂在它外面就是公开页面，
 *     即使页面自己会发需要令牌的请求，用户也会先看到一个空壳再被踢走。
 *   - 404 放在 AppLayout 内部而不是外面：登录后输错地址时，
 *     用户应该还看得见侧边导航，而不是掉进一个没有出口的裸页面。
 */
export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <AppLayout />,
            children: [
              { index: true, element: <Navigate to="/knowledge-base" replace /> },
              { path: 'knowledge-base', element: <KnowledgeBasePage /> },
              { path: 'documents', element: <DocumentsPage /> },
              { path: 'chat', element: <ChatPage /> },
              { path: 'conversations', element: <ConversationsPage /> },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
])
