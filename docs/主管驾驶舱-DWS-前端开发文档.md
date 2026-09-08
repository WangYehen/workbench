# 主管驾驶舱与 DWS 前端开发文档

> 状态：实施中（截至 2026-09-01）。第一阶段的主管四问界面已交付；管理事项详情、DWS 真实数据接口和写回动作仍待后端配套。

## 实施进度

| 范围 | 状态 | 当前情况 |
| --- | --- | --- |
| 行动中心移除“钉钉信号”标签 | 已完成 | `ActionsPage.jsx` 已删除 DWS 信号标签、独立同步按钮和页面挂载。 |
| 首页主管四问 | 已完成 | `ManagementQuestions.jsx` 已接入首页与行动中心，使用现有 `/attention` 数据。 |
| 管理事项 API | 已完成 | `managementApi` 已加入 `src/api.js`，后端 `/management/*` 已实现；前端仍需将首页和行动中心切换到该数据源。 |
| DWS 连接中心 | 未开始 | 当前仍使用旧系统页 DWS 配置区。 |
| 事项详情与证据时间线 | 未开始 | 当前点击事项仅定位到行动中心列表。 |
| DWS 确认后写回 | 后端基础已完成 | 后端已提供预览、确认门槛和审计；前端尚无预览弹窗，真实 DWS 写回连接器也尚未启用。 |
| 构建验证 | 已完成 | `npm run build` 已通过。 |

## 1. 目标与非目标

前端目标是帮助主管在首页快速回答四个问题：

1. 今天该先处理什么？
2. 哪些事情正在失控？
3. 该找谁推进？
4. 我应该做什么动作？

不再提供“钉钉工作信号”独立页。钉钉消息是管理事项的证据或协作上下文，不能作为自动生成任务的信息流。

本期不做全量聊天浏览器、未经确认的自动发消息/建待办/约会，也不在前端保存 DWS 凭据。

## 2. 信息架构与路由

保留现有页面：首页、行动中心、团队、日历、汇报、项目、设置。

改造如下：

| 位置 | 改造后职责 |
| --- | --- |
| 首页 `/` | 新增“今日管理重点”，按四问展示管理事项。 |
| 行动中心 `/actions` | 保留“注意事项、邮件、待办”；删除 `dingtalk` 标签及 `DingtalkMessagesPage` 挂载。注意事项改为管理事项列表。 |
| 团队 `/team` | 从成员、日报和阻塞进入对应管理事项。 |
| 日历 `/calendar` | 显示关联事项、会前准备和会后行动项。 |
| 设置 `/settings` | 将“钉钉个人消息（DWS）”升级为“钉钉连接中心”。 |

规划中的页面组件：

```text
src/pages/ManagementDashboardPage.jsx       // 首页四问区块，可由 Overview2Page 组合
src/pages/ManagementCasesPage.jsx           // 行动中心中的列表
src/components/ManagementCaseCard.jsx
src/components/ManagementCaseDetail.jsx
src/components/CaseEvidenceTimeline.jsx
src/components/CaseActionPreviewModal.jsx
src/components/DwsConnectionCenter.jsx
```

已实际创建：`src/components/ManagementQuestions.jsx`。当前它在首页和行动中心复用，事项点击会定位到现有注意事项列表；其余规划组件尚未创建。

## 3. 四问界面规格

### 3.1 今日需主管决策

展示不超过 5 项，按 P0/P1、截止时间、跨团队影响排序。卡片包括标题、管理结论、负责人、截止日期、来源标记和首选动作。

典型来源：高优先级邮件、需主管审核的日报、临期关键待办、异常审批。

### 3.2 风险与阻塞

展示逾期任务、项目风险、连续阻塞、会议后未落实行动项。每项必须显示“风险依据”，不能只有 AI 结论。

### 3.3 责任与协作

按人员或项目聚合：负责人、最近进展、阻塞数量、关联事项。人员详情中仅展示工作相关的事项和获授权的上下文。

### 3.4 今日行动

根据事项状态提供一个主动作，例如“指派待办”“确认解决路径”“约 30 分钟会议”“发送跟进草稿”。动作永远先进入预览弹窗。

## 4. 管理事项详情

`ManagementCaseDetail` 使用三段式布局：

1. **结论与状态**：标题、优先级、状态、负责人、截止时间、管理摘要。
2. **事实与上下文**：日报、待办、日程、邮件、项目、听记和按需查询的钉钉消息时间线。
3. **行动栏**：可执行动作、写入影响、最近一次执行结果。

状态仅使用：`decision_needed`、`in_progress`、`waiting`、`delegated`、`resolved`。状态改变必须立即刷新事项卡片和首页计数。

## 5. 前端 API 契约

在 `src/api.js` 新增：

```js
export const managementApi = {
  dashboard: (date) => api.get(`/management/dashboard?date=${date}`),
  cases: (filters) => api.get(`/management/cases?${new URLSearchParams(filters)}`),
  detail: (id) => api.get(`/management/cases/${encodeURIComponent(id)}`),
  update: (id, patch) => api.patch(`/management/cases/${encodeURIComponent(id)}`, patch),
  actionPreview: (id, action) => api.post(`/management/cases/${encodeURIComponent(id)}/actions/preview`, action),
  actionExecute: (id, action) => api.post(`/management/cases/${encodeURIComponent(id)}/actions/execute`, action),
};

export const dwsApi = {
  status: () => api.get('/dws/status'),
  capabilities: () => api.get('/dws/capabilities'),
};
```

`actionExecute` 必须传入 `confirmed: true`、`previewId` 与 `idempotencyKey`。未拿到预览或未明确确认时，按钮保持不可提交。

## 6. 与现有页面的衔接

- `ActionsPage.jsx`：已删除 `DingtalkMessagesPage` 导入、`dingtalk` tab 和独立同步按钮；当前使用 `ManagementQuestions` 加现有注意事项列表，待 `/management/cases` 上线后再替换为 `ManagementCasesPage`。
- `Overview2Page.jsx`：在原有概览卡片后插入四问区块，采用摘要接口，避免首页一次下载所有证据。
- `TodosPage.jsx`：显示“本地 / 已同步钉钉”状态；从管理事项进入时返回原事项。
- `CalendarPage.jsx`：会议卡片显示关联事项数与“查看行动项”。
- `SystemPage.jsx`：保留登录、保留策略和会话设置；新增当前 profile、能力矩阵、最后成功读取、部分失败说明。

## 7. 写回交互规范

所有 DWS 写动作遵循：

```text
点击动作 → 加载预览 → 展示对象、内容、影响范围 → 主管确认
→ 提交执行 → 展示回读结果 → 刷新事项与审计记录
```

首期支持的动作：创建/更新钉钉待办、按人员指派、创建日程、发送消息草稿。审批、取消日程和批量动作应单独以高风险样式展示。

## 8. 错误、空态与隐私

- DWS 未登录：引导至设置页连接，不显示伪造数据。
- 能力缺失：禁用相关动作，说明需要升级或授权。
- 数据部分成功：显示“部分数据可用”及失败来源，不能显示为同步成功。
- 无管理事项：显示“当前没有需要主管处理的事项”，同时保留进入待办、日历、团队的入口。
- 聊天原文默认折叠，仅在事项详情按需显示；不向浏览器传递 token、profile 原始对象或不必要的消息内容。

## 9. 前端验收

- 行动中心不再出现“钉钉信号”入口、文案或同步按钮。
- 首页四个区块都可展示空态、加载态、错误态和真实数据态。
- 管理事项能查看至少一个事实证据；卡片和详情状态一致。
- 任何写回操作都必须经过预览与确认；重复点击不会造成重复提交。
- DWS 未登录、组织不匹配、能力缺失、部分同步失败均有可理解提示。
- 执行 `npm run build` 成功。
