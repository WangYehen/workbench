# 钉钉消息 AI 行动箱需求文档

## 1. 背景与目标

当前钉钉消息页面以原始消息为主，用户点击“转为待办”后直接将消息内容写入待办，缺少上下文理解，导致待办生硬、噪音信息干扰行动判断。

本次改造目标是：让钉钉消息成为“AI 识别工作事项、理解上下文、生成可确认待办草稿”的入口，而不是消息归档列表。

## 2. 核心原则

- 群聊只关注 `@我` 的消息；其余群消息仅作为上下文，不作为独立事项展示。
- 单聊只展示与工作有关、且需要行动或需要人工确认的消息。
- 待办由 AI 综合消息及上下文生成，不直接复制原消息。
- AI 自动创建待办仅限高置信度且明确由当前用户处理的事项；其他待办先生成草稿，由用户确认。
- 原始消息、上下文和已过滤消息继续本地保留，但默认不干扰行动视图。

## 3. 页面与交互

### 3.1 左侧：会话目录

只展示已同步到符合展示规则消息、且仍存在待关注事项的会话：

- 群聊：存在未处理的 `@我` 根消息。
- 单聊：存在 AI 判断为“行动项”或“待确认”的消息。
- 已停用群聊不展示。
- 会话内消息均已处理、已忽略或已过滤后，会话自动从目录隐藏。
- 会话数量、红点数量与中间列表使用同一筛选规则。

### 3.2 中间：行动消息列表

中间列表只展示可行动的信息：

- 群聊：仅展示 `@我` 的根消息，不展示上下文消息。
- 单聊：仅展示 AI 判断为“行动项”或“待确认”的工作消息。
- 寒暄、确认词、机器人通知、普通同步、已过滤消息不进入默认列表。
- 支持按待处理、AI 待确认、已建待办、已关联、仅供知晓、已过滤筛选。
- “全部”表示全部符合行动箱展示规则的消息，不表示全部历史归档。

### 3.3 右侧：AI 分析与上下文

选择中间列表中的消息后，右侧展示：

- 消息来源、发送人、时间和原始内容。
- AI 判断：行动项、待确认、仅供知晓或已过滤；包含置信度和判断说明。
- AI 待办草稿：标题、说明、优先级、截止时间和生成依据。
- 与该消息对应的上下文。

上下文规则：

- 群聊：仅展示当前 `@我` 根消息前后各 10 条已归档专属上下文，不得混入该群其他消息。
- 单聊：展示所选消息前后各 10 条消息。
- AI 实际分析所用上下文必须与右侧展示内容一致。

## 4. 待办生成流程

### 4.1 自动创建

满足以下条件时，系统可自动创建待办：

- AI 判断为行动项；
- 明确由当前用户处理；
- 置信度不低于 90；
- 当前消息尚未创建过待办。

自动创建后，消息状态更新为“已建待办”，并展示对应待办信息。

### 4.2 人工确认创建

不满足自动创建条件时，用户可点击“生成待办草稿”：

1. AI 基于所选消息、会话信息和上下文生成待办草稿。
2. 在右侧展示并允许用户编辑标题、说明、优先级和截止时间。
3. 用户点击“确认创建待办”后写入待办系统。
4. 同一消息只能关联一个待办，重复操作不得创建重复待办。

AI 无法判断、上下文不足或生成失败时，不创建待办，提示用户补充判断或将消息标记为仅供知晓/忽略。

## 5. 数据与接口要求

- 为消息 AI 分析保存待办草稿、生成时间和生成依据，避免反复生成。
- 新增“生成待办草稿”接口与“确认创建待办”接口。
- 保留现有高置信度自动建待办能力。
- 消息列表、统计数量和会话目录均基于统一的业务筛选条件计算。
- 所有待办创建以消息 ID 保持幂等。

## 6. 验收标准

- 群聊列表中只出现 `@我` 根消息，上下文不单独出现。
- 群聊 AI 分析和右侧上下文不会混入同群无关消息。
- 单聊中寒暄、确认词和仅供知晓内容不进入默认行动列表。
- 单聊行动项和待确认事项正常出现，并可生成待办草稿。
- 待办草稿包含标题、说明、优先级、截止时间和依据，用户编辑后可正确创建。
- 自动建待办与人工确认建待办不会重复。
- 已处理会话从左侧目录隐藏；目录数量、筛选数量与中间列表一致。

## 7. 当前代码级 AI 调用审计（精确链路）

以下清单按当前代码追踪结果编写，术语中的 Producer/Queue/Consumer 指工作台现有的本地持久化 AI 队列；当前没有独立消息队列服务。

### 7.1 钉钉消息自动研判：异步队列主链路

| 页面 | API | Producer | Queue | Consumer | 实际 AI 调用与产物 |
|---|---|---|---|---|---|
| 行动中心 → 钉钉消息（`src/pages/ActionsPage.jsx` → `src/pages/DingtalkMessagesPage.jsx`）点击“同步并研判” | `POST /api/sync/run`，body `{ date, sources: ["dingtalk_chat"] }`；前端封装：`workbenchApi.syncRun()` | `server/core/sync-coordinator.mjs` 的 `runSource("dingtalk_chat")` 调 `dingtalkChatService.sync()`；同步完成后将新增消息与可重试消息交给 `aiScheduler.dingtalkChatMessagesArtifact(ids, { trigger: "sync" })` | SQLite `ai_tasks`：`kind=dingtalk.message.classify`、`scope=message.id`、`input_hash` 去重；同时写 `ai_artifacts` 状态 `queued/running/ready/failed/stale` | `server/ai/ai-scheduler.mjs` 的 `pumpAll()` → `pumpKind("dingtalk.message.classify")` → `execute(task)`；进程启动时 `start()` 会把中断中的 `running` 任务恢复为 `queued` | 先过滤短确认/寒暄；否则调用 `aiService.analyzeDingtalkMessage()`，写入 `dingtalk_message_analysis`，更新消息 `processing_status`，并对行动/项目动态持久化 `work_signals` 与证据 |

入队条件由 `dingtalkChatMessagesArtifact()` 实施：仅入站消息、非上下文消息；群聊必须是 `mentioned_me` 或 `mention_scope=all`。群聊 Consumer 使用 `context_root_id` 对应的根消息及其上下文；单聊使用同会话按所选消息时间最近的最多 21 条消息。群聊上下文不会单独入队。

### 7.2 行动中心读取与用户操作链路

| 页面 | API | Producer | Queue | Consumer | 结果 |
|---|---|---|---|---|---|
| 钉钉消息列表/筛选 | `GET /api/dingtalk-chat/inbox` | 无 | 无 | 无 | `dingtalkChatService.inbox()` 直接读取消息分析、信号和待办关联后的本地数据 |
| 选择消息查看详情 | `GET /api/dingtalk-chat/messages/:id`；信号项另走 `GET /api/dingtalk-chat/signals/:id` | 无 | 无 | 无 | 直接读取消息、AI 分析、上下文/证据 |
| 点击“转为待办”（消息项） | `POST /api/dingtalk-chat/messages/:id/task` | 无 | 无 | 无 | `createTodo()` 同步写 `todos`，按 `source_type=dingtalk_message + source_id` 幂等；不调用 AI |
| 点击“生成待办草稿” | `POST /api/dingtalk-chat/messages/:id/draft` | 路由直接调用 `dingtalkChatService.generateTodoDraft()` | **绕过 `ai_tasks` 本地队列，为同步直连调用** | 无 Queue Consumer；HTTP 请求内直接执行 | 若已有 `draft_generated_at` 且有标题则返回缓存，否则再次调用 `aiService.analyzeDingtalkMessage()`，写回 `dingtalk_message_analysis` |
| 编辑并确认待办草稿 | `POST /api/dingtalk-chat/messages/:id/draft/confirm` | 无 | 无 | 无 | `confirmTodoDraft()` 同步写入/更新草稿和 `todos`；同一消息只创建一个待办，消息置为 `task_created` |
| 信号项确认创建待办 | `POST /api/dingtalk-chat/signals/:id/draft/confirm` | 无 | 无 | 无 | `confirmSignalDraft()` 直接写待办及信号状态；不新增 AI 调用 |

### 7.3 当前项目中可见但不属于钉钉消息行动箱主链路的 AI 队列任务

同一个 `ai_tasks` Queue/Consumer 还处理 `dashboard.suggestion`（概览页工作建议）和 `team.analysis`（团队日志分析）。它们分别由 `system.js` 的概览建议读取/刷新、以及团队日志同步后的 `aiScheduler.teamAnalysisArtifact()` 产生；不应计入钉钉个人消息行动箱的消息研判调用数。

### 7.4 Producer → Queue → Consumer 结论

- 钉钉消息自动研判的唯一异步 Producer 是同步完成后的 `dingtalkChatMessagesArtifact()`；Queue 是 SQLite `ai_tasks`，Consumer 是 `ai-scheduler` 的按 kind 单并发 lane。
- 页面打开、列表读取、详情读取、状态更新和直接转待办均不触发 AI。
- “生成待办草稿”是当前唯一面向行动箱页面、但绕过 Queue 的 AI 调用；它可能与自动研判重复调用，虽有 `draft_generated_at` 缓存，但没有复用 `ai_tasks` 的任务结果。
- AI Provider 的实际选择统一经过 `server/ai/ai.mjs` 的 `execute()` 和 `routeFor()`；按配置可走 OpenCode、Codex、DeepSeek、OpenAI、Claude、Ollama 或本地 fallback。每次成功分析通过 `aiMeta` 记录 provider、model、失败尝试和耗时。
