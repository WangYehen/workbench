# AGENTS.md

## 项目概况

团队每日工作台：面向团队主管的本地优先 Web/桌面应用，聚合 Outlook 邮件、钉钉日志与日程，AI 分类分析，配合日报/周报、待办、复盘、日历与项目时间线。

## 常用命令

```bash
npm install          # 首次安装依赖
cp .env.example .env # 复制环境变量（可选，无配置时自动使用演示数据）
npm run dev          # 同时启动前端 (5174) + 后端 (8787)
npm run server       # 仅启动后端
npm run build        # 构建前端到 dist/client
npm run test         # 运行后端测试（node --test server/，目录递归扫描 *.test.mjs）
npm run electron:build  # 打包桌面应用到 release/
```

## 端口

- 前端：5174（可通过 WORKBENCH_PORT 环境变量覆盖）
- 后端：8787（可通过 PORT 环境变量覆盖）

## 目录结构

```
server/          Express 后端，入口 index.mjs
  routers/       9 个 API 路由模块（.js），outlook.js 含邮件回复草稿接口
  db.mjs         SQLite 数据库（.local/workbench.sqlite），含 migrate 机制
  config.mjs     配置读取（dotenv + 环境变量）
  ai.mjs         AI 适配层（chatJson + draftReply），支持 deepseek/openai/claude/ollama
  outlook-draft.mjs  邮件回复草稿编排（依赖注入，可单测）
  outlook-draft.test.mjs  草稿功能单测（用内存 SQLite + mock AI）
  demo.mjs       演示数据生成
src/             React 前端
  pages/         12 个页面组件（.jsx）
  components/    共享组件（AppShell、DatePicker、日期导航等）
  api.js         前端 API 封装（outlookApi 含 draft/getDraft）
  lib/           工具函数
electron/        Electron 主进程（main.mjs + preload.mjs）
```

## 重要约定

- 后端测试使用 Node.js 内置 test runner（`node --test`），不依赖第三方测试框架
- 无 linter/formatter 配置
- 数据库文件 `.local/` 和环境变量 `.env` 不纳入版本控制
- 无外部服务时自动注入演示数据（seedDemoIfEmpty）
- OAuth 回调经前端 5174 端口通过 Vite 代理转发至后端 8787
- 钉钉域名绕过代理直连（白名单要求，代理模式下可能导致 errcode 88/60020）
- 启动时自动探测代理可用性，不可用则回退直连
- 构建产物输出到 dist/client（electron-builder 打包时包含）
