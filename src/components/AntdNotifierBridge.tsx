import { App as AntdApp } from 'antd'
import { useEffect } from 'react'

import { registerNotifier } from '../utils/notify'

/**
 * 把 antd 的 message 实例注册给请求层。
 *
 * 通过 `App.useApp()` 获取实例（而不是用 `message.error` 静态方法），
 * 这样提示能正确消费 ConfigProvider 的主题 / 语言配置。
 * 必须在 `<AntdApp>` 内部渲染。
 */
export default function AntdNotifierBridge() {
  const { message } = AntdApp.useApp()

  useEffect(() => {
    registerNotifier({
      error: (content) => {
        void message.error(content)
      },
    })
    return () => registerNotifier(null)
  }, [message])

  return null
}
