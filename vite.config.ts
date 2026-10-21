import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000'

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        // 前端统一请求 /api，由 dev server 转发到后端，规避浏览器跨域
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          // 若后端路由本身不带 /api 前缀，打开下面这行把前缀去掉
          // rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  }
})
