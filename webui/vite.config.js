import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => ({
  // dsh 插件形态: --mode plugin 以 /touchstone/ 为 base 构建(dist-plugin); 独立形态不变(dist)
  base: mode === 'plugin' ? '/touchstone/' : '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // 开发时 API 与 SSE 转发到 4601 后端
      '/api': {
        target: 'http://127.0.0.1:4601',
        changeOrigin: false,
        // SSE 需要关闭代理缓冲, 否则事件不实时
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Cache-Control', 'no-cache')
          })
        },
      },
    },
  },
  build: {
    outDir: mode === 'plugin' ? 'dist-plugin' : 'dist',
    emptyOutDir: true,
  },
  // 单测（vitest，读本配置）：jsdom 环境供 skin/toast 等触碰 DOM/localStorage 的纯逻辑用例；
  // 只测 utils 与 stores 的纯逻辑，不做组件渲染（见 doc_ai/spec/webui/前端结构与约定.md）
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
  },
}))

