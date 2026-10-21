import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { RouterProvider } from 'react-router/dom'

import AntdNotifierBridge from './components/AntdNotifierBridge.tsx'
import { router } from './router'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          // 与产品原型一致的蓝色主色
          colorPrimary: '#2f6bef',
          borderRadius: 8,
        },
      }}
    >
      <AntdApp>
        {/* 把 antd message 实例注入请求层，使接口错误能统一弹出提示 */}
        <AntdNotifierBridge />
        <RouterProvider router={router} />
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
)
