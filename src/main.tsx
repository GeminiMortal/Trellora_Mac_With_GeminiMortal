/**
 * Module: main
 * React application entry point. Initializes theme, language, and startup splash,
 * then renders the root Application component after the main process is ready.
 * 模块：main
 * React 应用入口。初始化主题、语言和启动画面，
 * 然后在主进程就绪后渲染根 Application 组件。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@mantine/core/styles.css'
import Application from './Application.tsx'
import './styles/variables.css'
import './styles/macWindowDrag.css'
import './styles/codeBlockEditor.css'
import './styles/theme.css'
import { applyColorScheme, getDocumentLightColorScheme, getDocumentTheme } from './utils/ui/theme.ts'
import { initializeStartupSplash, showStartupError } from './utils/ui/startupSplash.ts'
import { setAppLanguage } from './i18n/index.ts'

// Set platform data attribute for CSS / 为 CSS 设置平台数据属性
if (window.electronAPI?.platform) document.documentElement.dataset.platform = window.electronAPI.platform
// Apply color scheme based on system theme / 根据系统主题应用配色方案
applyColorScheme(getDocumentTheme(), getDocumentLightColorScheme())
// Set application language / 设置应用语言
setAppLanguage(document.documentElement.lang)
// Initialize startup splash screen / 初始化启动画面
initializeStartupSplash()

// The first HTML frame is already visible while the main process scans the library.
// 主进程扫描资料库时第一帧 HTML 已经可见。
void (window.electronAPI?.waitForStartup?.() ?? Promise.resolve()).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Application />
    </StrictMode>,
  )
}).catch(() => showStartupError())
