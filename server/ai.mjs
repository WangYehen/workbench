import { config } from "./config.mjs";

function currentProvider() {
  const p = config.ai.provider;
  if (p === "ollama") return p;
  const creds = config.ai[p];
  if (creds && creds.apiKey) return p;
  // 没有对应密钥时回退到 ollama（本地）或标记不可用
  return p;
}

async function chatJson(system, user, opts = {}) {
  const provider = currentProvider();
  const { temperature = 0.2 } = opts;
  try {
    if (provider === "deepseek" || provider === "openai") {
      const c = config.ai[provider];
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify({
          model: c.model,
          temperature,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) throw new Error(`AI ${provider} HTTP ${res.status}`);
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content);
    }
    if (provider === "claude") {
      const c = config.ai.claude;
      const res = await fetch(`${c.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": c.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: c.model,
          max_tokens: 2000,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) throw new Error(`AI claude HTTP ${res.status}`);
      const data = await res.json();
      return JSON.parse(extractJson(data.content[0].text));
    }
    if (provider === "ollama") {
      const c = config.ai.ollama;
      const res = await fetch(`${c.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: c.model,
          format: "json",
          stream: false,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`AI ollama HTTP ${res.status}`);
      const data = await res.json();
      return JSON.parse(data.message.content);
    }
  } catch (err) {
    err.code = "AI_CALL_FAILED";
    throw err;
  }
  throw new Error("AI provider not configured");
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : text;
}

export const ai = {
  available() {
    return config.ai.provider !== "deepseek" || Boolean(config.ai.deepseek.apiKey);
  },

  async classifyEmails(emails) {
    const system =
      "你是团队主管的邮件助理。给定邮件列表，逐封分析并返回结构化 JSON。" +
      "字段定义：" +
      "  needs_action: true=需主管亲自处理（决策/审批/回复/风险升级/明确截止且重要），false=无需处理（通知/抄送/已委派/纯 informational）。" +
      "  reason: 一句话说明为何这样分类，给主管参考。" +
      "  confidence: 0-1 之间的置信度。" +
      "  summary: 一句话中文摘要。" +
      "  action: 如果 needs_action=true，给主管一个动作建议（祈使句，10-20 字，例如「回复确认预算口径」「与客户沟通延期」）。如果 needs_action=false，可填空字符串。" +
      "  priority: 'high'/'medium'/'low' 三档。仅当 needs_action=true 时评估。" +
      "    high: 客户/财务/法务/升级故障/明确今日或已逾期截止。" +
      "    medium: 一般内部决策/审批/确认，1-3 天内有截止。" +
      "    low: 抄送类、5 天外截止、或只有弱触发条件。" +
      "  priorityReason: 一句话说明为何是这个优先级。" +
      "返回严格 JSON：{\"items\":[{\"id\":\"原始id\",\"needs_action\":true/false,\"reason\":\"\",\"confidence\":0.0,\"summary\":\"\",\"action\":\"\",\"priority\":\"high|medium|low\",\"priorityReason\":\"\"}]}";
    const user = JSON.stringify(
      emails.map((e) => ({
        id: e.id,
        subject: e.subject,
        sender: e.sender,
        importance: e.importance,
        hasFlag: Boolean(e.has_flag),
        dueAt: e.due_at,
        preview: (e.preview || "").slice(0, 400),
      })),
    );
    return chatJson(system, user);
  },

  async analyzeReports(reports) {
    const system =
      "你是团队管理分析助手。给定已按成员分开的钉钉日志，为【每个成员】独立提炼：进展摘要(summary)、阻塞点(blockers)、需主管审核/决策的要点(reviewItems)。\n" +
      "硬性要求：\n" +
      "1. members 数组必须【每个成员一条】，name 字段必须用原始姓名原样返回，userId 用原始 userId（可能为空，但 name 必填且唯一）。\n" +
      "2. summary：一句话（20-40 字），必须引用该成员日志里的【具体工作项/模块名/需求单号】，体现其真实进展；不同成员的 summary 必须明显不同，禁止套话、禁止复制粘贴相同句子、禁止“完成XX多项需求”这类空洞概括。\n" +
      "3. blockers/reviewItems：仅在该成员日志确实提到阻塞或需主管审核时才给，否则给空数组 []。\n" +
      "返回严格 JSON：{\"teamSummary\":\"一段话\",\"members\":[{\"userId\":\"原始id\",\"name\":\"姓名\",\"summary\":\"一句话\",\"blockers\":[\"..\"],\"reviewItems\":[\"..\"]}]}";
    const user = JSON.stringify(
      reports.map((r) => ({
        userId: r.user_id,
        name: r.user_name,
        date: r.report_date,
        content: r.content_json,
      })),
    );
    return chatJson(system, user, { temperature: 0.4 });
  },

  async weeklySummary(dailyReports) {
    const system =
      "基于一周的每日工作回顾，生成团队周报。包含：本周关键进展、主要风险与阻塞、需要协调的事项、下周重点。" +
      "返回 JSON：{\"highlights\":[\"..\"],\"risks\":[\"..\"],\"coordination\":[\"..\"],\"nextWeek\":[\"..\"],\"narrative\":\"一段总结\"}";
    const user = JSON.stringify(dailyReports.map((d) => ({ date: d.report_date, content: d.content_json })));
    return chatJson(system, user, { temperature: 0.4 });
  },

  async summarizeReview(review) {
    const system =
      "将主管的每日复盘整理为结构化要点。返回 JSON：{\"did\":[\"..\"],\"learned\":[\"..\"],\"mistake\":[\"..\"],\"mood\":\"情绪标签\"}";
    const user = JSON.stringify(review);
    return chatJson(system, user);
  },

  async dailySuggestion(summary, feedback = "") {
    const feedbackHint =
      feedback === "bad"
        ? "用户觉得上一条不够好，请换一个更具体、角度不同的建议。"
        : feedback === "good"
          ? "用户认可上一条，可保持这种风格。"
          : "";
    const system =
      "你是团队主管的私人日程助理，语气像晨会上一个靠谱同事随口提醒，自然、有温度。" +
      "基于今日数据，用一句不超过 60 字的话点出当天最该聚焦的事，要带判断、不要罗列数字。" +
      "若当日很轻松，就鼓励专注或休息。" +
      (feedbackHint ? " " + feedbackHint : "") +
      "返回严格 JSON：{\"suggestion\":\"一句话\"}";
    const user = JSON.stringify(summary);
    return chatJson(system, user);
  },
};
