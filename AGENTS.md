# AGENTS.md

## 项目概况

个人AI工作台：面向个人主管的本地优先 Web/桌面应用，聚合 Outlook 邮件、钉钉日志与日程，AI 分类分析，配合日报/周报、待办、复盘、日历与项目时间线。

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
  ai/            AI 服务、运行时、调度、OpenCode 适配与 AI 热点
  integrations/  Outlook（含草稿）、钉钉（含个人消息）与 DWS 连接
  domains/       待办同步、管理事项、项目状态、工作台聚合与 DWS Agent
  core/          自动同步协调、上海时区日期工具与演示数据
  routers/       14 个 API 路由模块（Outlook、团队、日历、待办、汇报、项目、系统、DWS 等）
  prompts/       AI 提示词
  tests/         10 个后端测试，按 ai/dingtalk/dws/outlook/workflow 分类
  db.mjs         SQLite 数据库（.local/workbench.sqlite），含 migrate 机制
  config.mjs     配置读取（dotenv + 环境变量）
  index.mjs      后端组合根与启动入口
src/             React 前端
  pages/         16 个页面组件（.jsx），含指挥台、行动中心、团队、日历、项目、汇报和设置等
  components/    共享组件（AppShell、DatePicker、日期导航等）
  api.js         前端 REST 与 SSE API 封装（含 Outlook 草稿、DWS Agent 等）
  lib/           工具函数
electron/        Electron 主进程（main.mjs + preload.mjs）
```

## 重要约定

### 后端文件职责分层

- 新增后端代码必须按职责放入既有层级：AI 逻辑放 `server/ai/`，第三方连接放 `server/integrations/`，业务规则放 `server/domains/`，跨模块基础能力放 `server/core/`，HTTP 接口放 `server/routers/`，提示词放 `server/prompts/`，测试放 `server/tests/<模块>/`。
- `server/index.mjs` 仅负责组装依赖、注册路由和启动服务；`server/config.mjs` 与 `server/db.mjs` 保持为共享入口，不承载具体业务功能。
- 不得将新的 `*.test.mjs` 与功能实现文件混放在 `server/` 根目录或任一功能目录；测试文件按模块归类，并随功能移动同步更新导入路径。
- 跨层依赖应单向保持为：`routers → domains / integrations / ai / core`；业务层不得依赖路由层。确需复用路由中的逻辑时，应先下沉为独立服务或工具模块。

- 后端测试使用 Node.js 内置 test runner（`node --test`），不依赖第三方测试框架
- 无 linter/formatter 配置
- 数据库文件 `.local/` 和环境变量 `.env` 不纳入版本控制
- 无外部服务时自动注入演示数据（seedDemoIfEmpty）
- OAuth 回调经前端 5174 端口通过 Vite 代理转发至后端 8787
- 钉钉域名绕过代理直连（白名单要求，代理模式下可能导致 errcode 88/60020）
- 启动时自动探测代理可用性，不可用则回退直连
- 构建产物输出到 dist/client（electron-builder 打包时包含）
- UI页面风格保持统一，组件能复用就复用
