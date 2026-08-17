import { getDb, upsert } from "./db.mjs";
import { config } from "./config.mjs";

function uuid() {
  return "d" + Math.random().toString(36).slice(2, 10);
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function isoAt(daysAgo, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}
function isoMinutesFromNow(min) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + min);
  return d.toISOString();
}
function outlookLink(msgId) {
  // 真实 Outlook 用 Graph 返回的 webLink；演示模式下用搜索型 deeplink 占位
  return `https://outlook.office.com/mail/search/id/${encodeURIComponent(msgId)}`;
}

export function seedDemoIfEmpty() {
  const db = getDb();
  const counts = {
    emails: db.prepare("SELECT COUNT(*) c FROM emails").get().c,
    reports: db.prepare("SELECT COUNT(*) c FROM dingtalk_reports").get().c,
    todos: db.prepare("SELECT COUNT(*) c FROM todos").get().c,
    projects: db.prepare("SELECT COUNT(*) c FROM projects").get().c,
    calendars: db.prepare("SELECT COUNT(*) c FROM calendars").get().c,
  };
  const today = new Date().toISOString().slice(0, 10);

  if (counts.emails === 0) {
    const now = new Date().toISOString();
    const emails = [
      // 已逾期
      {
        subject: "回复: Q3 预算调整说明",
        sender: "王磊",
        sender_email: "wang.lei@finance.com",
        received_at: isoAt(4, 9, 12),
        importance: "high",
        has_flag: 1,
        needs_action: 1,
        action: "回复财务部确认预算口径",
        due_at: isoAt(2, 18, 0),
        preview: "张总好，附件为 Q3 预算调整说明初稿，请确认预算口径与原计划差异，重点关注市场推广费用下调是否影响下半年节奏。如有问题请尽快回复。",
        reason: "需主管确认财务口径，影响后续执行",
        confidence: 0.92,
        summary: "财务部 Q3 预算调整说明待确认",
        priority: "high",
        priority_reason: "财务需在月结前确认口径",
        due_source: "邮件原文",
      },
      {
        subject: "活动合作物料与报价单提交截止提醒",
        sender: "李娜",
        sender_email: "lina@market.com",
        received_at: isoAt(3, 10, 0),
        importance: "high",
        has_flag: 1,
        needs_action: 1,
        action: "提交活动合作物料与报价单",
        due_at: isoAt(1, 12, 0),
        preview: "提醒：活动合作物料与报价单需于今日 12:00 前提交，否则排期延后一周。请尽快补齐。",
        reason: "明确截止且影响排期",
        confidence: 0.88,
        summary: "市场活动物料与报价单待提交",
        priority: "medium",
        priority_reason: "品牌方要求指定时间前提交",
        due_source: "邮件原文",
      },
      // 今天截止
      {
        subject: "服务商扩容方案与报价",
        sender: "陈晨",
        sender_email: "chen.chen@ops.com",
        received_at: isoAt(1, 14, 0),
        importance: "high",
        has_flag: 1,
        needs_action: 1,
        action: "确认扩容方案并回复是否同意",
        due_at: isoAt(0, 18, 0),
        preview: "张总，今晚 20:00 安排运维窗口实施扩容，请尽快回复是否同意方案。附件为新版报价。",
        reason: "运维窗口今晚安排实施，需主管拍板",
        confidence: 0.95,
        summary: "今晚扩容方案待主管拍板",
        priority: "high",
        priority_reason: "运维窗口今晚安排实施",
        due_source: "邮件原文",
      },
      {
        subject: "客户拜访计划确认",
        sender: "赵刚",
        sender_email: "zhao.gang@sales.com",
        received_at: isoAt(1, 11, 30),
        importance: "normal",
        has_flag: 1,
        needs_action: 1,
        action: "确认拜访时间与参会人员",
        due_at: isoAt(0, 17, 0),
        preview: "本周拜访需在今日 17:00 前确认时间，请回复与会人员安排。",
        reason: "客户对接需主管确认出席",
        confidence: 0.9,
        summary: "客户拜访时间与会人员待确认",
        priority: "medium",
        priority_reason: "需协调客户与高层时间",
        due_source: "邮件原文",
      },
      {
        subject: "请确认样品规格与交期（附件）",
        sender: "供应商 张敏",
        sender_email: "zhang.min@xyz.com",
        received_at: isoAt(0, 9, 0),
        importance: "normal",
        has_flag: 0,
        needs_action: 1,
        action: "确认样品规格与交期",
        due_at: isoAt(0, 16, 0),
        preview: "张总好，随附样品规格表（附件 1）与初步问题，期望今日 16:00 前确认。",
        reason: "供应商等待确认，影响采购下单",
        confidence: 0.9,
        summary: "样品规格与交期待确认",
        priority: "medium",
        priority_reason: "影响采购下单与生产排期",
        due_source: "邮件原文",
      },
      // 稍后 / 无需处理
      {
        subject: "【通知】公司团建报名开启",
        sender: "HR",
        sender_email: "hr@demo.com",
        received_at: isoAt(0, 8, 30),
        importance: "normal",
        has_flag: 0,
        needs_action: 0,
        action: "",
        due_at: null,
        preview: "各位同事好，本月团建报名已开启，请于本周五前完成线上报名。",
        reason: "抄送通知，无需主管处理",
        confidence: 0.97,
        summary: "团建报名通知",
        priority: "",
        priority_reason: "",
        due_source: "",
      },
      {
        subject: "周会纪要 8 月第 2 周",
        sender: "助理 周婷",
        sender_email: "zhou.ting@demo.com",
        received_at: isoAt(1, 18, 0),
        importance: "low",
        has_flag: 0,
        needs_action: 0,
        action: "",
        due_at: null,
        preview: "本周周会纪要详见附件，请查阅。",
        reason: "已分发各部门，纯记录",
        confidence: 0.93,
        summary: "周会纪要",
        priority: "",
        priority_reason: "",
        due_source: "",
      },
    ].map((e) => ({
      id: uuid(),
      subject: e.subject,
      sender: e.sender,
      sender_email: e.sender_email,
      received_at: e.received_at,
      importance: e.importance,
      has_flag: e.has_flag,
      due_at: e.due_at,
      preview: e.preview,
      web_link: outlookLink(uuid()),
      needs_action: e.needs_action,
      reason: e.reason,
      confidence: e.confidence,
      summary: e.summary,
      action: e.action,
      priority: e.priority,
      priority_reason: e.priority_reason,
      due_source: e.due_source,
      source: "demo",
      created_at: now,
    }));
    upsert("emails", emails, ["id"]);
  }

  // 注意：钉钉日志报告（dingtalk_reports）与团队成员（dingtalk_members）不再播演示种子，
  // 改为完全依赖真实钉钉同步（同步后写入）。这样概览页「团队阻塞点 / 待审核 / 未提交」
  // 不会出现演示假数据；未连接钉钉时这些模块自然为空，等待真实数据填充。

  if (counts.projects === 0) {
    const now = new Date().toISOString();
    const p1 = uuid();
    const p2 = uuid();
    const p3 = uuid();
    upsert(
      "projects",
      [
        { id: p1, name: "商户中心 2.0", owner: "你", color: "#378ADD", note: "核心交易链路升级", progress: 76, created_at: now },
        { id: p2, name: "数据看板", owner: "你", color: "#639922", note: "经营分析平台", progress: 40, created_at: now },
        { id: p3, name: "官网改版", owner: "你", color: "#a855f7", note: "品牌官网焕新", progress: 60, created_at: now },
      ],
      ["id"],
    );
    const phase = (pid, phase, offset, len) => ({
      id: uuid(),
      project_id: pid,
      phase,
      start_date: isoDaysAgo(offset),
      end_date: isoDaysAgo(offset - len),
      note: "",
      created_at: now,
    });
    upsert(
      "project_phases",
      [
        // p1 商户中心：进行中、健康（最终节点在 +17 天）
        phase(p1, "需求评审", 10, 3),
        phase(p1, "产品设计", 7, 3),
        phase(p1, "开发", 3, 14),
        phase(p1, "测试", -11, 5),
        phase(p1, "上线", -16, 1),
        // p2 数据看板：开发节点在 +5 天（≤7）→ 进度 40%<70% → 有风险
        phase(p2, "需求评审", 8, 2),
        phase(p2, "产品设计", 6, 2),
        phase(p2, "开发", 4, 9),
        phase(p2, "测试", -5, 4),
        phase(p2, "上线", -9, 1),
        // p3 官网改版：全部阶段已过去、进度 60%<100% → 已逾期
        phase(p3, "需求评审", 40, 3),
        phase(p3, "产品设计", 37, 3),
        phase(p3, "开发", 34, 20),
        phase(p3, "测试", 14, 5),
        phase(p3, "上线", 9, 1),
      ],
      ["id"],
    );
  } else if (config.useDemoData) {
    // 已有演示库：补齐进度，使风险预警可见（仅针对内置演示项目名）
    const backfill = [
      { name: "商户中心 2.0", progress: 76 },
      { name: "数据看板", progress: 40 },
    ];
    const db2 = getDb();
    for (const b of backfill) {
      db2.prepare("UPDATE projects SET progress=? WHERE name=? AND progress=0").run(b.progress, b.name);
    }
  }

  // 注意：日历会议（calendars）不再播演示种子，改为完全依赖真实钉钉日程同步
  // （同步后写入 source='dingtalk' 的行）。这样概览页「今日会议日程」不会出现演示假会议；
  // 未连接钉钉时该模块自然为空，等待真实数据填充。

  for (const n of [0, 1, 2, 3, 4]) {
    const d = isoDaysAgo(n);
    const db2 = getDb();
    const hasReview = db2.prepare("SELECT id FROM daily_reviews WHERE review_date=?").get(d);
    if (!hasReview) {
      db2.prepare(
        "INSERT OR IGNORE INTO daily_reviews(id, review_date, did, learned, mistake, mood, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(uuid(), d, `处理了 ${2 + n} 项关键事务`, "钉钉日志接口的分页规则", n % 2 ? "未及时同步日程" : "", ["好", "平稳", "焦虑"][n % 3], new Date().toISOString(), new Date().toISOString());
    }
    const hasDaily = db2.prepare("SELECT id FROM daily_reports WHERE report_date=?").get(d);
    if (!hasDaily) {
      db2.prepare(
        "INSERT OR IGNORE INTO daily_reports(id, report_date, content_json, generated_at) VALUES(?,?,?,?)",
      ).run(uuid(), d, JSON.stringify({ summary: `第 ${n} 天自动汇总` }), new Date().toISOString());
    }
  }
}
