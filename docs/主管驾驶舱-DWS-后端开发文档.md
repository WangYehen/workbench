# 主管驾驶舱与 DWS 后端开发文档

> 状态：规划稿。本文定义从“钉钉工作信号”迁移到主管管理事项与 DWS 协作底座的服务端实施方案。

## 1. 架构原则

- 保留现有企业应用同步：钉钉日志、团队成员与日程仍可沿用 `server/dingtalk.mjs`。
- DWS 提供主管个人工作面的读取与确认后写回：待办、日历、通讯录、消息、听记、审批。
- 消息不是自动事项来源；消息仅作为已存在管理事项的按需证据。
- 写操作必须使用同一 DWS profile，先预览、后确认、执行后回读。
- 任何分页失败或部分结果必须透传完整性状态，禁止当作成功。

## 2. 模块拆分

将 `server/dingtalk-chat.mjs` 中通用的命令执行、JSON 解析、能力探测、部分结果 ledger 与登录状态抽到：

```text
server/dws-client.mjs
server/dws-connectors/todo.mjs
server/dws-connectors/calendar.mjs
server/dws-connectors/contact.mjs
server/dws-connectors/chat.mjs
server/dws-connectors/minutes.mjs
server/dws-connectors/approval.mjs
server/management-cases.mjs
server/routers/dws.js
server/routers/management.js
```

`dingtalk-chat.mjs` 在过渡期只保留消息归档、会话设置和附件按需下载，内部改为调用 `dws-connectors/chat.mjs`；不得继续生成 `work_signals`。

## 3. DWS Client 契约

`dws-client.mjs` 提供：

```js
createDwsClient({ executable, run, now })
  .status({ force })
  .currentProfile()
  .capabilities({ force })
  .read(command, options)
  .preview(command, payload)
  .executeConfirmed(command, payload, { previewId, idempotencyKey })
```

硬性要求：

- 所有结构化调用使用 `--format json`。
- `currentProfile()` 只接受明确的当前组织 profile；多候选或组织不明确时返回可处理错误。
- `read()` 返回 `{ data, ledger }`；`ledger` 至少含 `complete`、`partial`、`hasMore`、`failures`、`nextCursor`。
- `executeConfirmed()` 不接受缺失 `confirmed`、`previewId` 或 `idempotencyKey` 的请求。
- 写后由 connector 读取真实对象回验，再返回 `externalId` 和验证结果。
- 登录状态接口只投影组织、用户、profile、版本和连接状态，绝不向 API 返回 token。

## 4. 数据模型与迁移

在 `server/db.mjs` 采用幂等迁移创建：

```sql
CREATE TABLE management_cases (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'decision_needed',
  priority TEXT NOT NULL DEFAULT 'P2',
  title TEXT NOT NULL,
  management_summary TEXT,
  owner_id TEXT,
  owner_name TEXT,
  due_at TEXT,
  project_id TEXT,
  source_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE management_case_evidence (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES management_cases(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  role TEXT NOT NULL,
  excerpt TEXT,
  occurred_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(case_id, source_type, source_id)
);

CREATE TABLE management_case_actions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES management_cases(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  preview_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  external_id TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  executed_at TEXT
);
```

迁移策略：

1. 创建新表，不修改或删除 `work_signals`。
2. 停止信号自动写入后，保留旧表一个发布周期作为只读回退数据。
3. 已由信号创建的本地待办维持原样；不迁移为新事项，避免把历史 AI 判断重新激活。
4. 新驾驶舱稳定后删除信号路由、提示词、AI 调度与旧表写入；表删除必须作为单独、可审计的迁移。

## 5. 管理事项生成

在 `management-cases.mjs` 以确定性规则生成并按 `source_hash` 幂等 upsert：

| 来源 | 触发条件 | 类别 | 默认动作 |
| --- | --- | --- | --- |
| `todos` / DWS Todo | 逾期或 48 小时内到期且未完成 | `execution_risk` | 指派/调整截止日 |
| `dingtalk_reports` | blocker 或 needs_review 非空 | `team_blocker` | 确认解决路径 |
| `projects` | `at_risk` 或 `overdue` | `project_risk` | 制定缓解方案 |
| `emails` | 高优先级且需要行动 | `decision_needed` | 处理或委派 |
| `calendars` / Minutes | 临近会议或未落实行动项 | `meeting_follow_up` | 准备/创建行动项 |
| OA | 待处理且临近时限 | `approval_needed` | 审阅审批 |

AI 只能对已生成事项写入摘要或动作建议；不得将聊天、日志或听记的自由文本直接写成新事项。

## 6. API 设计

### 管理事项

```text
GET    /api/management/dashboard?date=YYYY-MM-DD
GET    /api/management/cases?state=&category=&ownerId=&date=
GET    /api/management/cases/:id
PATCH  /api/management/cases/:id
POST   /api/management/cases/:id/actions/preview
POST   /api/management/cases/:id/actions/execute
```

`dashboard` 返回四问分组、总数、数据完整性和更新时间；不要返回所有消息原文。

### DWS 连接

```text
GET /api/dws/status
GET /api/dws/capabilities
POST /api/dws/sync/todos
POST /api/dws/sync/calendar
```

同步接口按既有 `sync-coordinator.mjs` 模式记录来源、时间、计数、错误和部分成功状态。待办和日历的 DWS 同步需避免与企业应用日程重复：以外部 ID + source 区分并显式去重。

### 动作请求

预览请求示例：

```json
{ "type": "todo.assign", "assigneeQuery": "张三", "dueAt": "2026-09-02T18:00:00+08:00" }
```

执行请求示例：

```json
{
  "type": "todo.assign",
  "previewId": "preview_xxx",
  "idempotencyKey": "uuid",
  "confirmed": true
}
```

后端必须从预览缓存读取实际参数，不能信任客户端在执行请求中重新提交的人员 ID、会话 ID 或消息内容。

## 7. DWS 写回范围

首期：

- 创建、更新、完成、指派钉钉待办。
- 查询人员/部门并补全负责人。
- 创建日程、邀请参会人、查询闲忙。
- 生成并发送主管确认的私聊/群消息。

后续：

- 听记行动项转待办。
- 审批查询与处理。
- DWS 实时事件只刷新相关管理事项，不创建消息信号流。

取消日程、删除待办、批量写入、审批通过/拒绝均为高风险动作，必须有专用确认文案和回读验证。

## 8. 测试计划

新增 Node 内置测试：

```text
server/dws-client.test.mjs
server/dws-connectors.test.mjs
server/management-cases.test.mjs
server/management-router.test.mjs
```

必须覆盖：

- 未安装、未登录、profile 不明确、权限不足和命令超时。
- 分页完整、部分成功、失败 ledger 与数据保留。
- 管理事项去重、状态流转、证据关联、手工编辑。
- 写操作缺确认被拒绝；确认后回读成功；重复幂等键不重复执行。
- 停止 DWS 消息 AI 分析后，不再创建 `work_signals`。
- 既有 `dingtalk-chat.test.mjs`、`sync-coordinator.test.mjs` 与 `workbench-domain.test.mjs` 继续通过。

最终验证：

```text
npm run test
npm run build
```

## 9. 回滚与观测

- 发布初期使用功能开关启用管理驾驶舱；旧数据只读保留。
- 每次 DWS 同步记录 profile、能力版本、结果计数、部分失败和 trace 信息；不得记录 token。
- 每次动作写入 `management_case_actions`，保存预览、执行时间、外部 ID 与回读结果。
- 出现 DWS 故障时，首页继续展示本地已有数据，并明确标注 DWS 数据的最后成功时间。
