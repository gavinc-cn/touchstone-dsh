import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// webui/ 根目录（本配置文件所在目录）与仓库根词表目录（webui/ 之外）
const webuiDir = path.dirname(fileURLToPath(import.meta.url))
// 词表在仓库根：单一真源 i18n/en.json，前端构建期内联
const i18nDir = path.resolve(webuiDir, '../i18n')

export default defineConfig(({ mode }) => ({
  // dsh 插件形态: --mode plugin 以 /touchstone/ 为 base 构建(dist-plugin); 独立形态不变(dist)
  base: mode === 'plugin' ? '/touchstone/' : '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(webuiDir, 'src'),
      '@i18n': i18nDir,
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // dev 模式只放行 webui 自身与仓库根 i18n/：@i18n/en.json 位于 webui/ 之外，默认只允许
    // webui 会被 fs 拦截；不放行整个仓库根（KB-47，dev-only 收窄；生产构建不受影响）
    fs: { allow: [webuiDir, i18nDir] },
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
