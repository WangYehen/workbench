# 系统 AI 分析能力整改与任务队列优化方案

**文档版本：** V1.0  
**日期：** 2026-09-11  
**整改目标：** 降低无效 AI 调用、解决 AI 任务队列积压、规范 AI 能力使用边界，并建立稳定、可控、可观测的 AI 任务体系。

---

## 1. 背景

当前系统在多个业务页面和数据处理流程中接入了 AI 分析能力。

随着功能持续增加，部分业务逐渐形成了以下模式：

```text
业务数据产生
    ↓
自动创建 AI 分析任务
    ↓
进入 AI Task Queue
    ↓
LLM 分析
    ↓
存储分析结果
```

当邮件、Todo、钉钉事项、日报、团队信号等多个数据源同时采用类似模式时，AI 任务数量会随着业务数据量快速增加。

目前已经观察到 AI 任务队列出现明显积压。

初步判断，问题并不只是 AI Worker 消费能力不足，更重要的是：

> 当前系统部分场景存在 AI 使用范围过宽、触发粒度过细、重复生成任务、页面行为触发 AI 等问题。

因此本次整改不应简单通过增加消费者数量解决，而需要重新定义：

> **什么场景应该使用 AI，什么时候调用 AI，以及同一份数据最多允许分析多少次。**

---

# 2. 整改目标

本次整改主要解决以下问题：

1. 减少没有实际业务价值的 AI 调用。
2. 避免页面访问、刷新导致重复创建 AI Task。
3. 避免同一业务数据被重复分析。
4. 将逐条 AI 分析改为聚合分析。
5. 建立统一 AI Task 幂等机制。
6. 建立 AI 任务优先级机制。
7. 保证用户主动 AI 操作优先执行。
8. 降低 AI Token 和模型调用成本。
9. 提升 AI Task Queue 的稳定性。
10. 建立 AI 调用监控和可观测能力。

最终目标：

```text
AI Task 数量
↓
AI Queue 积压
↓
LLM Token 消耗
↓
重复分析
↓

核心 AI 能力响应速度
↑
AI 结果质量
↑
系统稳定性
↑
```

---

# 3. AI 使用原则调整

后续所有 AI 功能建议遵循以下原则：

> **AI 不应该因为“系统获得了数据”而执行，而应该因为“系统需要进行复杂判断”才执行。**

普通业务逻辑优先使用：

```text
SQL
规则判断
状态机
排序
过滤
聚合
缓存
统计
```

只有以下类型问题才建议进入 AI：

```text
非结构化信息理解
复杂内容摘要
跨数据源总结
风险识别
趋势判断
语义分析
管理决策辅助
自然语言交互
```

因此整体处理链路应从：

```text
业务数据
   ↓
AI
   ↓
业务结果
```

调整为：

```text
业务数据
   ↓
规则处理
   ↓
结构化结果
   ↓
是否真的需要 AI？
   ↓
只有必要场景进入 AI
```

---

# 4. 当前 AI 使用点代码审计清单

> 审计基线：2026-09-11 当前工作区代码。以下清单按真实调用链整理；“Queue”仅指 `server/ai/ai-scheduler.mjs` 内的 SQLite `ai_tasks` 持久队列，不把普通 Promise 串行队列或外部同步流程误称为 AI Task Queue。

| 页面/调用方 | API | Producer | Queue | Consumer | 实际 AI 能力与触发 | 现状判定 |
|---|---|---|---|---|---|---|
| 指挥台（`OverviewPage.jsx`）及数据同步后的后台流程 | `GET /api/overview/suggestion`；显式生成 `POST /api/ai/artifacts/dashboard.suggestion/:scope/regenerate`；同步入口 `POST /api/sync/run` | 同步协调器每个成功数据源同步后调用 `aiScheduler.dashboardArtifact()`；显式 regenerate 同样调用并带 `force=true`；普通 GET 使用 `enqueueTask=false` | `ai_tasks.kind=dashboard.suggestion`，`scope=date`；按 `priority DESC, created_at ASC` 取任务；同 `input_hash` 的 ready/queued/running 去重 | `ai-scheduler.mjs:pumpKind()` → `execute()` → `aiService.dailySuggestion()` → `ai_artifacts` | 读取当天聚合上下文生成指挥台建议；页面 GET 只读缓存或规则兜底，数据同步/显式 regenerate 才入队 | **已落实页面只读；同步与手动重生成仍会生产** |
| 团队日报页（`TeamPage.jsx`） | `GET /api/team/dashboard`；同步入口 `POST /api/sync/run`（`dingtalk`） | `server/core/sync-coordinator.mjs` 按实际日报日期调用 `teamAnalysisArtifact()`；团队 dashboard GET 已移除 Producer 调用 | `ai_tasks.kind=team.analysis`，`scope=report_date`；团队日报日期 + 输入 hash 去重 | `pumpKind()` → `execute()` → `aiService.analyzeReports(reports)` → 更新 `dingtalk_reports.blockers/needs_review/summary`，并写 `ai_artifacts` | 将同一日期全部成员日报聚合为一次团队分析；手动同步设置 `force=true`，会绕过已有结果重新排队 | **已聚合且页面 GET 只读；手动同步会强制重算** |
| 钉钉消息页/行动中心钉钉 Tab（`DingtalkMessagesPage.jsx`） | 同步：`POST /api/sync/run`；读取：`GET /api/dingtalk-chat/inbox`、`GET /api/dingtalk-chat/messages/:id` | `sync-coordinator.mjs` 仅在 `trigger=manual` 时收集新增及可重试消息 ID 并调用 `dingtalkChatMessagesArtifact()`；后台自动同步只入库 | `ai_tasks.kind=dingtalk.message.classify`，`scope=message.id`；消息 id + 内容 + 发送时间 hash 去重 | `pumpKind()` → `execute()` → `aiService.analyzeDingtalkMessage()`；结果写 `dingtalk_message_analysis`，行动/项目更新再写 signal | 用户点击“同步并研判”后分类/摘要/识别行动项；短确认消息在 Consumer 内走 noise filter，不调用 LLM；页面加载只读 inbox/detail | **已切断后台自动 AI；保留用户主动研判** |
| 邮件页/行动中心邮件 Tab（`EmailsPage.jsx`） | `POST /api/outlook/sync`；读取 `GET /api/outlook/*` | 手动同步在 `outlook.mjs` 调用 `taskScheduler.classifyEmail()`；后台自动同步传 `allowAi=false`，不生产 AI 任务 | `ai_tasks.kind=email.classify`，`scope=message.id`；消息身份/内容 hash 去重 | `pumpKind()` → `execute()` → `aiService.classifyOutlookEmail()`；结果写入 `ai_artifacts`，再由 Outlook 同步镜像到邮件表 | 邮件同步最多拉取 50 封；手动同步逐封经队列分类，后台同步只写 uncertain 人工确认状态 | **已切断后台自动逐封 AI；手动分类已接入统一队列** |
| 邮件详情（`EmailsPage.jsx`） | `POST /api/outlook/messages/:id/draft`；读取 `GET /api/outlook/messages/:id/draft` | 无 Queue；`server/integrations/outlook-draft.mjs:generateDraft()` 直接调用 | **无** | `ai.draftReply()` → 保存/返回草稿 | 用户点击生成回复草稿时触发；不是页面挂载自动调用 | **用户主动调用，建议保留；当前无任务审计/幂等队列** |
| 日报页（`DailyReportPage.jsx`） | `POST /api/reports/daily/generate`；读取 `GET /api/reports/daily` | `server/routers/reports.js` 计算 source hash 后调用 `aiScheduler.enqueue(kind=report.daily)` | `ai_tasks.kind=report.daily`，`scope=date`；等待任务完成后读回报告 | `pumpKind()` → `execute()` → `aiService.weeklySummary()` → 写 `daily_reports.content_json` 与 `ai_artifacts` | 用户点击“生成日报”触发；相同输入复用队列 artifact，不重复调用模型 | **已接入统一队列；仍为用户主动触发** |
| 周报页（`WeeklyReportPage.jsx`） | `POST /api/reports/weekly/generate`；读取 `GET /api/reports/weekly` | `server/routers/reports.js` 基于周范围及日报内容 hash 后调用 `aiScheduler.enqueue(kind=report.weekly)` | `ai_tasks.kind=report.weekly`，`scope=weekStart..weekEnd`；等待任务完成后读回报告 | `pumpKind()` → `execute()` → `aiService.weeklySummary()` → 写 `weekly_reports.content_json` 与 `ai_artifacts` | 用户点击生成，按周读取已有 daily_reports 聚合后调用一次 | **已接入统一队列；仍为用户主动触发** |
| DWS Agent（对话页） | `POST /api/dws-agent/conversations/:id/turns`（SSE）；确认 `POST /confirm` | `server/routers/dws-agent.js` → `dws-agent.mjs`；工具读取真实数据，Agent 运行中按需调用 AI/本地能力 | **不进入 `ai_tasks`**；Agent 自有 run/turn 状态 | DWS Agent 服务的 SSE turn 执行链；确认动作再写本地管理事项或调用 DWS | 用户主动自然语言请求；例如读取日报后分析团队卡点，或执行管理动作前预览/确认 | **独立 Agent 链路；不能计入 AI Task Queue** |
| AI 热点页（`AiHotPage.jsx`） | `GET /api/ai-hot` | 无 Producer/本地 AI 调用；`server/ai/aihot.mjs` 读取 AI HOT 外部匿名只读数据并做本地筛选/聚合 | **无** | 外部 AI HOT API → 本地 `aihot.mjs` 归一化 | 页面加载/刷新读取外部已生成热点，不调用本项目 LLM | **名称含 AI，但不属于本项目 AI 调用或 Queue** |

### 4.1 队列实现与当前 Consumer 清单

| 项目 | 代码事实 |
|---|---|
| Queue 存储 | `server/db.mjs` 的 `ai_tasks`，状态实际为 `queued/running/ready/failed`；`ai_artifacts` 保存按 `kind + scope` 的结果；系统状态额外暴露当天创建量 `createdToday` |
| Producer 统一入口 | `createAiScheduler().enqueue()`；邮件分类、钉钉消息、指挥台、团队分析、日报、周报均经该入口；邮件草稿与 DWS Agent 保持独立的用户主动链路 |
| 调度方式 | `enqueue()` 后 `pumpAll()`；每个 kind 一个 `runningKinds` lane，同 kind 串行；不同 kind 的并行数受 `config.ai.maxConcurrency`（环境变量 `AI_MAX_CONCURRENCY`）限制 |
| Consumer | `pumpKind()` 从 `ai_tasks` 取最高优先级任务，执行六种 kind：`email.classify`、`dingtalk.message.classify`、`dashboard.suggestion`、`team.analysis`、`report.daily`、`report.weekly`；进程重启会把 running 改回 queued |
| 优先级 | `ai_tasks.priority` 已存在并排序；当前实现是 kind 内优先级排序，不是 P0/P1/P2 独立 worker；`PRIORITY` 具体值以 `ai-scheduler.mjs` 为准 |
| Retry | 已实现最多 3 次尝试；失败后按 30 秒、2 分钟、10 分钟指数退避重新进入 `queued`，超过上限置 `failed`；启动时恢复中断的 running 任务 |
| Metrics | Scheduler 暴露 queued/running/ready/failed、createdToday、dedupHits、inputTokens/outputTokens/totalTokens、averageDurationMs、最近成功/失败任务；供应商返回 usage 时归一化为 `aiMeta.usage` 并写入 `ai_tasks.input_tokens/output_tokens`，未返回时保持 null |
| Prompt Version | `ai_tasks.prompt_version` 与 `ai_artifacts.prompt_version` 同步记录各任务类型版本：邮件、钉钉消息、指挥台、团队分析、日报、周报分别使用稳定版本标识 |
| 页面自动触发证据 | 本轮已移除 `GET /api/team/dashboard` 的 Producer 调用，并让 `GET /api/overview/suggestion` 使用 `enqueueTask=false`；当前页面常规 GET 均不直接创建 `ai_tasks`。同步流程和显式 regenerate 仍是允许的后台生产入口 |

---

# 5. AI 能力重新分类

## 5.1 必须保留

### 5.1.1 Team Signals

Team Signals 是当前比较适合 AI 的功能。

AI 可以从团队日报中识别：

```text
项目风险
阻塞事项
跨团队依赖
延期风险
异常问题
重复问题
关键成果
需要管理者关注的问题
```

这些信息依赖自然语言理解和跨成员信息综合，因此适合使用 LLM。

但需要改变分析粒度。

错误方式：

```text
成员 A 日报 → AI
成员 B 日报 → AI
成员 C 日报 → AI
成员 D 日报 → AI
```

假设团队 20 人：

```text
20 人
×
1 次 AI
=
20 AI Tasks
```

推荐调整为：

```text
昨日全部团队日报
        ↓
统一聚合
        ↓
一次 AI Team Analysis
        ↓
Team Signals
```

最终：

```text
20 Tasks
↓
1 Task
```

同时上下文更加完整，分析质量通常也会更高。

---

## 5.2 AI Daily Summary

每日总结同样属于比较适合 AI 的场景。

例如：

```text
Todo
+
邮件
+
钉钉事项
+
日报
+
项目进展
+
日历事项
      ↓
Daily Summary
```

AI 的核心价值是：

> 对多个来源的信息进行压缩和总结。

建议继续保留。

但是需要建立严格幂等规则：

```text
userId
+
summaryDate
+
summaryType
```

同一个用户同一天只允许创建一次 Daily Summary。

例如：

```text
USER_10001
2026-09-11
DAILY_SUMMARY
```

无论接口、定时任务或重试调用多少次：

```text
最多只允许存在一个有效分析任务。
```

---

## 5.3 用户主动 AI 分析

例如：

```text
帮我分析这个事项

总结这封邮件

分析今天最重要的工作

总结这份日报

帮我判断当前项目风险
```

这类 AI 请求具有明确用户意图。

建议作为系统 AI 能力最高优先级。

---

# 6. 建议改为按需触发的 AI 能力

## 6.1 Todo AI 分析

Todo 通常已经包含：

```text
标题
优先级
负责人
截止时间
状态
来源
创建时间
更新时间
```

以下判断完全没有必要调用 AI：

```text
是否逾期
是否今天到期
优先级
负责人
是否完成
是否超过 N 天未更新
来源分类
状态统计
```

这些全部可以通过业务规则完成。

例如：

```java
if (dueTime.isBefore(now) && status != DONE) {
    overdue = true;
}
```

AI 应只用于：

> “我今天有 23 个待办，综合截止时间、项目优先级和上下文帮我选出最应该处理的 5 个。”

即：

```text
Todo 本身
不自动 AI

用户需要决策
才调用 AI
```

---

# 7. 建议取消自动 AI 分析的能力

## 7.1 钉钉事项

钉钉事项通常已经存在完整结构化字段。

例如：

```text
事项标题
创建人
负责人
截止日期
优先级
完成状态
来源
更新时间
```

这些字段已经能够支持：

```text
筛选
排序
提醒
逾期判断
状态统计
负责人统计
```

因此不建议：

```text
每同步一个钉钉事项
        ↓
自动创建 AI Task
```

推荐：

```text
新事项
   ↓
普通业务规则
   ↓
入库
   ↓
结束
```

只有用户主动点击：

```text
AI 分析
```

或者事项内容复杂到必须提取行动项时，再调用 AI。

---

# 8. Team Daily Report 调整

团队日报建议拆成两个层级。

### Level 1：普通日报数据

日报提交之后直接保存：

```text
done
plan
problem
remark
```

不立即调用 AI。

### Level 2：Team Signals

每天固定时间统一读取昨日团队日报：

```text
所有日报
   ↓
聚合 Prompt
   ↓
一次 Team AI Analysis
   ↓
Team Signals
```

这样可以避免：

```text
N 个员工
=
N 个 AI Task
```

---

# 9. 禁止页面访问触发 AI

这是本次整改中非常重要的一项。

需要重点扫描前端代码：

```tsx
useEffect(() => {
    analyze();
}, []);
```

以及类似：

```tsx
if (!analysisResult) {
    createAnalysisTask();
}
```

这类代码非常危险。

因为以下行为都可能重新创建任务：

```text
刷新浏览器

页面重新挂载

React StrictMode

接口自动 Retry

切换 Tab

多个浏览器窗口

组件重新渲染
```

页面应该遵循：

```text
Page
 ↓
GET Analysis Result
```

而不是：

```text
Page
 ↓
POST Create AI Analysis
```

即：

> 前端负责展示结果，后端负责决定是否应该创建 AI Task。

例如 Command Center：

```http
GET /api/team-signals?date=2026-09-10
```

而不应该：

```http
POST /api/ai/team-signals/analyze
```

随着页面加载自动执行。

---

# 10. AI Task 幂等机制

建议所有 AI Task 引入统一：

```text
dedup_key
```

建议组成：

```text
analysisType
+
sourceType
+
sourceId
+
sourceVersion
```

例如：

```text
TODO_ANALYSIS
DING_TASK
198273
V3
```

计算：

```text
SHA256(
    analysisType
    + sourceType
    + sourceId
    + sourceVersion
)
```

数据库：

```sql
UNIQUE KEY uk_ai_task_dedup (dedup_key)
```

这样可以避免：

```text
接口重复调用

MQ 重复消息

定时任务重跑

服务 Retry

页面刷新

消费者异常重试
```

产生重复 AI Task。

---

# 11. Content Hash 机制

对于日报、邮件、Todo 等文本型数据，建议增加：

```text
content_hash
```

例如：

```text
SHA256(
    title
    + content
    + description
)
```

AI Result 保存：

```text
source_id

source_type

source_hash

analysis_type

analysis_result

model

prompt_version

created_at
```

下一次分析之前：

```text
currentHash == oldHash
```

则直接返回历史结果。

不再进入 AI Queue。

只有：

```text
内容真正发生变化
```

才允许重新分析。

---

# 12. AI Result Cache

建议形成：

```text
业务数据
   ↓
Content Hash
   ↓
查询 AI Result
   ↓
Cache Hit？
```

如果：

```text
Yes
```

直接返回：

```text
existingResult
```

如果：

```text
No
```

再进入：

```text
AI Queue
```

完整流程：

```text
Business Data
      ↓
Rule Processing
      ↓
Need AI?
    /     \
  No       Yes
  ↓         ↓
 END    Content Hash
            ↓
       Result Exists?
        /        \
      Yes        No
       ↓          ↓
     Cache     AI Queue
                  ↓
                 LLM
                  ↓
               Result DB
```

---

# 13. AI Task Queue 优先级

当前 AI Queue 不应该采用简单 FIFO。

建议至少拆分为三个逻辑优先级。

| 优先级 | 类型 | 示例 |
|---|---|---|
| P0 | 用户主动 AI | 点击“AI 分析” |
| P1 | 核心 AI | Team Signals |
| P2 | 后台 AI | Daily Summary / 趋势 |

消费优先级：

```text
P0
>>>>>>>>>>>>>>>>>

P1
>>>>>>>>>

P2
>>>>
```

这样即使：

```text
后台 AI Task = 500
```

用户主动点击：

```text
AI 分析
```

也不会排在第 501 位。

---

# 14. AI Worker 并发控制

不建议无限增加 AI Worker。

因为：

```text
Worker ↑
```

可能导致：

```text
LLM API 并发 ↑

Rate Limit ↑

Token Cost ↑

数据库压力 ↑

消息竞争 ↑
```

建议根据模型 API Rate Limit 设置：

```text
AI Worker Concurrent Limit
```

例如：

```text
P0 Worker = 5

P1 Worker = 3

P2 Worker = 1
```

具体值需要根据模型 API 限制及实际吞吐压测确定。

---

# 15. Retry 机制调整

AI 调用失败时不能无限 Retry。

建议：

```text
MAX_RETRY = 3
```

例如：

```text
Retry 1
30 秒

Retry 2
2 分钟

Retry 3
10 分钟
```

采用：

```text
Exponential Backoff
```

超过最大 Retry：

```text
FAILED
```

进入人工观察或补偿任务。

禁止：

```text
while (failed) {
    retry();
}
```

---

# 16. AI Task 状态

建议统一状态：

```text
PENDING

RUNNING

SUCCESS

FAILED

CANCELLED
```

同时记录：

```text
created_time

start_time

finish_time

retry_count

model

token_input

token_output

duration_ms

error_message
```

这样后续才能真正分析 AI 系统瓶颈。

---

# 17. 队列积压监控

建议建立以下指标。

### Queue Size

```text
ai_task_pending_total
```

### Running

```text
ai_task_running_total
```

### Task Duration

```text
ai_task_duration_seconds
```

### Failure Rate

```text
ai_task_failure_rate
```

### Token

```text
ai_token_input_total

ai_token_output_total
```

### Daily Task

```text
ai_task_created_daily
```

### Duplicate

```text
ai_task_dedup_hit_total
```

其中：

```text
ai_task_dedup_hit_total
```

非常重要。

它能够直接告诉我们：

> 幂等机制到底帮助系统拦截了多少无效 AI 请求。

---

# 18. 第一阶段：立即止血

优先级：

**P0**

建议第一阶段立即执行以下整改：

1. 禁止页面加载自动创建 AI Task。
2. 关闭新 Todo 自动 AI 分析。
3. 关闭新钉钉事项自动 AI 分析。
4. 检查邮件同步是否存在逐封自动 AI。
5. Team Daily Report 停止逐人 AI 分析。
6. Team Signals 改为团队每日一次聚合分析。
7. Daily Summary 增加每日唯一约束。
8. AI Task 增加 Dedup Key。

这一阶段的目标不是优化模型，而是：

> **立即停止无价值任务继续进入 Queue。**

---

# 19. 第二阶段：任务体系改造

优先级：

**P1**

实施：

```text
Content Hash

AI Result Cache

Task Priority

Retry Policy

Worker Concurrency

AI Task Metrics
```

建立统一：

```text
AiTaskService
```

所有 AI 功能禁止自行操作 Queue。

例如：

```java
aiTaskService.submit(request);
```

统一负责：

```text
Dedup

Cache

Priority

Retry

Queue

Metrics
```

---

# 20. 第三阶段：AI Gateway

如果系统后续 AI 能力继续增加，建议建立统一 AI Gateway。

架构：

```text
Todo
Email
DingTalk
Daily Report
Command Center
       │
       ▼
┌─────────────────┐
│    AI Gateway   │
├─────────────────┤
│ Dedup           │
│ Cache           │
│ Prompt          │
│ Rate Limit      │
│ Priority        │
│ Retry           │
│ Model Routing   │
│ Cost Control    │
└────────┬────────┘
         │
         ▼
       LLM
```

业务模块不直接调用：

```text
OpenAI
Claude
Gemini
DeepSeek
```

而统一通过 AI Gateway。

---

# 21. Prompt Version

AI Result 建议记录：

```text
prompt_version
```

例如：

```text
TEAM_SIGNAL_V1

TEAM_SIGNAL_V2
```

只有 Prompt 发生重大变化时：

```text
Prompt V1 → V2
```

才允许批量重新生成 AI Result。

否则旧结果继续复用。

---

# 22. 推荐最终保留的核心 AI 能力

系统最终建议重点保留三类 AI 能力。

## Team Signals

用于：

```text
风险识别

阻塞识别

跨成员依赖

团队趋势

管理关注点
```

执行方式：

```text
团队级批处理
每天一次
```

---

## Daily Summary

用于：

```text
跨数据源总结

每日工作摘要

重要信息提炼
```

执行方式：

```text
User + Date
每天一次
```

---

## User Requested AI

用于：

```text
分析事项

总结邮件

分析 Todo

辅助决策

自然语言提问
```

执行方式：

```text
用户主动触发
```

优先级：

```text
最高
```

---

# 23. 不建议使用 AI 的功能

以下场景默认使用普通业务逻辑：

```text
Todo 是否逾期

Todo 排序

事项状态

事项负责人

日期判断

优先级

数量统计

趋势数字

是否完成

今日到期

超期时间

来源判断

简单分类

普通搜索
```

核心原则：

> 能用 SQL、规则、状态机解决的问题，不使用 LLM。

---

# 24. 建议增加 AI 功能准入规则

后续新增 AI 功能时，需求评审必须回答四个问题：

### 问题一

不用 AI 能否完成？

如果：

```text
可以
```

优先不使用 AI。

### 问题二

是否需要理解自然语言？

如果：

```text
否
```

通常不需要 AI。

### 问题三

AI 是否能够显著降低用户决策成本？

如果：

```text
否
```

不建议加入 AI。

### 问题四

调用频率是多少？

必须预估：

```text
DAU

单用户调用次数

每日 AI Task 数

Token

模型成本
```

之后才能上线。

---

# 25. 推荐数据库字段

AI Task：

```text
id

task_type

source_type

source_id

source_hash

dedup_key

priority

status

retry_count

model

prompt_version

input_token

output_token

created_time

start_time

finish_time

error_message
```

其中重点字段：

```text
source_hash

dedup_key

priority

prompt_version
```

---

# 26. 验收指标

本次整改建议至少观察以下指标。

### AI Task 数量

目标：

```text
下降 70% 以上
```

如果当前存在大量逐条分析，实际可能下降：

```text
80%～95%
```

---

### Duplicate AI Task

目标：

```text
接近 0
```

---

### Queue Pending

目标：

```text
正常情况下接近 0
```

---

### 用户 AI 请求等待时间

目标：

```text
P95 < 10 秒
```

具体仍取决于模型响应速度。

---

### Team Signals

目标：

```text
每天每团队 <= 1 个主要 AI Task
```

---

### Daily Summary

目标：

```text
每天每用户 <= 1 个主要 AI Task
```

---

# 27. 需要进行的代码审计

下一步需要针对项目进行一次完整代码扫描。

重点关键词：

```text
ai

analysis

analyze

insight

summary

llm

chat

completion

agent

prompt

embedding

AI Task

AI Queue
```

同时扫描前端：

```text
useEffect

onMounted

watch

watchEffect

componentDidMount
```

确认是否存在：

```text
页面加载
        ↓
AI API
```

同时扫描后端：

```text
MQ Producer

Scheduler

Event Listener

Async

Retry

Cron

Task
```

确定：

```text
谁在创建 AI Task

什么情况下创建

一天创建多少

是否存在重复创建
```

最终形成完整：

```text
AI 调用地图
```

格式建议：

| 页面 | 功能 | API | Producer | Task Type | Trigger | QPS | 是否必要 |
|---|---|---|---|---|---|---|---|

这张表完成以后，才能正式确认系统中是否还有遗漏 AI 调用。

---

# 28. 最终建议架构

```text
                     Business Data
                           │
                           ▼
                  ┌─────────────────┐
                  │ Business Rules  │
                  └────────┬────────┘
                           │
                     Need AI?
                      /        \
                    No          Yes
                    │            │
                   END           ▼
                          ┌─────────────┐
                          │ Content Hash│
                          └──────┬──────┘
                                 │
                          Result Exists?
                           /          \
                         Yes          No
                          │            │
                       Result          ▼
                              ┌────────────────┐
                              │ AI Task Service│
                              ├────────────────┤
                              │ Dedup          │
                              │ Priority       │
                              │ Rate Limit     │
                              │ Retry          │
                              │ Metrics        │
                              └────────┬───────┘
                                       │
                                       ▼
                                  AI Queue
                                       │
                                       ▼
                                   AI Worker
                                       │
                                       ▼
                                      LLM
                                       │
                                       ▼
                                  AI Result DB
```

---

# 29. 总结

本次问题的根本原因不应该简单理解为：

> AI Worker 太少。

更准确的问题是：

> **AI 被放到了太多业务数据入口，并且缺乏统一的任务准入、去重、缓存和调度机制。**

因此整改方向应该从：

```text
增加消费者
```

转变为：

```text
减少无效生产
+
防止重复生产
+
聚合 AI 分析
+
任务分级
+
结果复用
```

最终系统中的 AI 应逐步收敛到：

```text
Team Signals
+
Daily Summary
+
User Requested AI
```

三类核心能力。

AI 不需要存在于每一个页面。

真正合理的 AI 产品设计应该是：

> **用户需要复杂理解和决策时 AI 出现，普通业务逻辑则保持确定、快速和低成本。**

---

# 30. 整改优先级

```text
P0
│
├─ 禁止页面访问触发 AI
├─ 停止普通 Todo 自动 AI
├─ 停止钉钉事项自动 AI
├─ Team Report 停止逐条 AI
├─ Team Signals 改每日聚合
└─ AI Task 增加 Dedup

P1
│
├─ Content Hash
├─ Result Cache
├─ Priority Queue
├─ Retry Policy
├─ Worker Limit
└─ Metrics

P2
│
├─ AI Gateway
├─ Prompt Version
├─ Model Routing
├─ Token Cost Control
└─ AI Observability
```

建议优先完成 P0。

**在 P0 完成之前，不建议通过单纯增加 AI Worker 数量解决当前队列积压。**
