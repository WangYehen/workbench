import { z } from "zod";
import { config } from "./config.mjs";
import { apiProviderOrder, createDefaultAiAdapters } from "./ai-runtime.mjs";
import {
  classifyEmailsSystemPrompt,
  formatEmailsForClassification,
  analyzeReportsSystemPrompt,
  formatReportsForAnalysis,
  weeklySummarySystemPrompt,
  formatDailyReportsForWeeklySummary,
  summarizeReviewSystemPrompt,
  buildDailySuggestionSystemPrompt,
  buildDraftReplySystemPrompt,
  reliableClassifierPromptSystem,
  reliableClassifierPromptUser,
} from "./prompts/index.mjs";

const OUTLOOK_CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    queue: { type: "string", enum: ["action", "informational", "uncertain"] },
    actionType: { type: "string", enum: ["reply", "approval", "confirmation", "submission", "deadline", "other"] },
    actionText: { type: "string" },
    dueAt: { type: ["string", "null"] },
    dueSource: { type: "string", enum: ["explicit", "inferred", "none"] },
    priority: { type: "string", enum: ["P0", "P1", "P2"] },
    priorityReason: { type: "string" },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string" },
  },
  required: ["queue", "actionType", "actionText", "dueAt", "dueSource", "priority", "priorityReason", "confidence", "summary"],
};

const EMAIL_LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" }, needs_action: { type: "boolean" }, reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }, summary: { type: "string" },
          action: { type: "string" }, priority: { type: "string", enum: ["high", "medium", "low"] },
          priorityReason: { type: "string" },
        },
        required: ["id", "needs_action", "reason", "confidence", "summary", "action", "priority", "priorityReason"],
      },
    },
  },
  required: ["items"],
};

const REPORT_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    teamSummary: { type: "string" },
    members: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          userId: { type: ["string", "null"] }, name: { type: "string" }, summary: { type: "string" },
          blockers: { type: "array", items: { type: "string" } },
          reviewItems: { type: "array", items: { type: "string" } },
        },
        required: ["userId", "name", "summary", "blockers", "reviewItems"],
      },
    },
  },
  required: ["teamSummary", "members"],
};

const WEEKLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    highlights: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    coordination: { type: "array", items: { type: "string" } },
    nextWeek: { type: "array", items: { type: "string" } },
    narrative: { type: "string" },
  },
  required: ["highlights", "risks", "coordination", "nextWeek", "narrative"],
};

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    did: { type: "array", items: { type: "string" } },
    learned: { type: "array", items: { type: "string" } },
    mistake: { type: "array", items: { type: "string" } },
    mood: { type: "string" },
  },
  required: ["did", "learned", "mistake", "mood"],
};

const SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { suggestion: { type: "string" } },
  required: ["suggestion"],
};

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { body: { type: "string" } },
  required: ["body"],
};

const DINGTALK_MESSAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    classification: { type: "string", enum: ["action", "informational", "uncertain"] },
    summary: { type: "string" }, actionText: { type: "string" }, dueDate: { type: ["string", "null"] },
    priority: { type: "string", enum: ["P0", "P1", "P2"] }, confidence: { type: "integer", minimum: 0, maximum: 100 }, assigneeSelf: { type: "boolean" },
    draftTitle: { type: "string" }, draftNote: { type: "string" }, draftDueDate: { type: ["string", "null"] },
    draftPriority: { type: "string", enum: ["P0", "P1", "P2"] }, draftRationale: { type: "string" },
    signal: { type: "object", additionalProperties: false, properties: {
      title: { type: "string" }, conclusion: { type: "string" }, facts: { type: "array", items: { type: "string" } }, steps: { type: "array", items: { type: "string" } },
      mergeSignalId: { type: ["string", "null"] }, mergeConfidence: { type: "integer", minimum: 0, maximum: 100 }, evidenceMessageIds: { type: "array", items: { type: "string" } },
      associations: { type: "array", items: { type: "object", additionalProperties: false, properties: { targetType: { type: "string", enum: ["outlook", "calendar", "project", "todo"] }, targetId: { type: "string" }, confidence: { type: "integer", minimum: 0, maximum: 100 }, reason: { type: "string" } }, required: ["targetType", "targetId", "confidence", "reason"] } },
    }, required: ["title", "conclusion", "facts", "steps", "mergeSignalId", "mergeConfidence", "evidenceMessageIds", "associations"] },
  },
  required: ["classification", "summary", "actionText", "dueDate", "priority", "confidence", "assigneeSelf"],
};

const outlookClassification = z.object({
  queue: z.enum(["action", "informational", "uncertain"]),
  actionType: z.enum(["reply", "approval", "confirmation", "submission", "deadline", "other"]),
  actionText: z.string(),
  dueAt: z.string().nullable(),
  dueSource: z.enum(["explicit", "inferred", "none"]),
  priority: z.enum(["P0", "P1", "P2"]),
  priorityReason: z.string(),
  confidence: z.number().int().min(0).max(100),
  summary: z.string(),
});

const emailList = z.object({ items: z.array(z.object({
  id: z.string(), needs_action: z.boolean(), reason: z.string(), confidence: z.number().min(0).max(1),
  summary: z.string(), action: z.string(), priority: z.enum(["high", "medium", "low"]), priorityReason: z.string(),
})) });

const reportAnalysis = z.object({
  teamSummary: z.string(),
  members: z.array(z.object({
    userId: z.string().nullable(), name: z.string(), summary: z.string(), blockers: z.array(z.string()), reviewItems: z.array(z.string()),
  })),
});

const weekly = z.object({
  highlights: z.array(z.string()), risks: z.array(z.string()), coordination: z.array(z.string()),
  nextWeek: z.array(z.string()), narrative: z.string(),
});
const reviewSummary = z.object({ did: z.array(z.string()), learned: z.array(z.string()), mistake: z.array(z.string()), mood: z.string() });
const suggestion = z.object({ suggestion: z.string().min(1) });
const draft = z.object({ body: z.string().min(1) });
const dingtalkMessage = z.object({
  classification: z.enum(["action", "informational", "uncertain"]), summary: z.string(), actionText: z.string(), dueDate: z.string().nullable(),
  priority: z.enum(["P0", "P1", "P2"]), confidence: z.number().int().min(0).max(100), assigneeSelf: z.boolean(),
  draftTitle: z.string(), draftNote: z.string(), draftDueDate: z.string().nullable(),
  draftPriority: z.enum(["P0", "P1", "P2"]), draftRationale: z.string(),
  signal: z.object({ title: z.string(), conclusion: z.string(), facts: z.array(z.string()), steps: z.array(z.string()), mergeSignalId: z.string().nullable(), mergeConfidence: z.number().int().min(0).max(100), evidenceMessageIds: z.array(z.string()), associations: z.array(z.object({ targetType: z.enum(["outlook", "calendar", "project", "todo"]), targetId: z.string(), confidence: z.number().int().min(0).max(100), reason: z.string() })) }).optional(),
});

function compactReportSummary(report) {
  const raw = String(report?.content_json || "");
  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") text = parsed;
    else if (Array.isArray(parsed)) text = parsed.map((item) => item?.value || item?.content || "").filter(Boolean).join("；");
  } catch { /* 使用原始文本。 */ }
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "未提供有效日志内容";
}
function localDailySuggestion(summary) {
  const parts = [];
  if (summary.riskProjects > 0) parts.push(`优先推进 ${summary.riskProjects} 个风险项目`);
  if (summary.pendingEmails > 0) parts.push(`处理 ${summary.pendingEmails} 封待处理邮件`);
  if (summary.meetingCount > 0) parts.push(`为 ${summary.firstMeetings?.[0]?.time || "稍后"} 的会议预留准备时间`);
  if (summary.blockers > 0) parts.push(`尽快拍板 ${summary.blockers} 个团队卡点`);
  if (summary.openTodos > 0) parts.push(`清理 ${summary.openTodos} 条未完成待办`);
  return { suggestion: parts.length ? `${parts.slice(0, 2).join("，")}。` : "当前日期没有高优先级注意事项，可以安排一段不被打断的专注时间。" };
}

function localDraft(tone) {
  const opening = tone === "friendly" ? "您好，感谢您的来信。" : "您好，已收到您的邮件。";
  const middle = tone === "action" ? "我正在核实相关信息，确认后会尽快给出明确回复。" : "我正在核实相关信息，确认后会尽快回复。";
  return { body: `${opening}\n\n${middle}\n\n谢谢。` };
}

function providerLabel(id) {
  return { opencode: "OpenCode 免费模型", codex: "Codex CLI", deepseek: "DeepSeek API", openai: "OpenAI API", claude: "Claude API", ollama: "Ollama", local: "本地规则" }[id] || id;
}

export function createAiService({ runtimeConfig = config, adapters = createDefaultAiAdapters(runtimeConfig), now = () => new Date() } = {}) {
  let statusCache = null;
  let statusInFlight = null;

  function routeFor(sensitivity) {
    if (runtimeConfig.ai.routingMode !== "smart") return [runtimeConfig.ai.provider];
    const apiProviders = apiProviderOrder(runtimeConfig);
    return sensitivity === "sensitive"
      ? ["codex", ...apiProviders]
      : ["opencode", "codex", ...apiProviders];
  }

  async function execute({ kind, sensitivity, system, user, schema, validator, fallback, temperature = 0.2 }) {
    const attempts = [];
    const providers = routeFor(sensitivity).filter((id, index, list) => adapters[id] && list.indexOf(id) === index);
    for (const provider of providers) {
      const startedAt = Date.now();
      try {
        const result = await adapters[provider].generate({ kind, sensitivity, system, user, schema, temperature });
        const providerData = kind === "dashboard.suggestion" && result.data && typeof result.data === "object"
          ? { suggestion: result.data.suggestion || result.data.__text || Object.values(result.data).find((value) => typeof value === "string") }
          : result.data;
        const data = validator.parse(providerData);
        return {
          ...data,
          aiMeta: {
            provider,
            providerLabel: providerLabel(provider),
            model: result.model || "",
            attemptedProviders: [...attempts.map((item) => item.provider), provider],
            fallbackUsed: attempts.length > 0,
            durationMs: Date.now() - startedAt,
            generatedAt: now().toISOString(),
          },
        };
      } catch (error) {
        attempts.push({ provider, code: error?.code || "invalid_output" });
      }
    }
    const data = validator.parse(fallback());
    return {
      ...data,
      aiMeta: {
        provider: "local",
        providerLabel: providerLabel("local"),
        model: "deterministic",
        attemptedProviders: [...attempts.map((item) => item.provider), "local"],
        fallbackUsed: true,
        durationMs: 0,
        generatedAt: now().toISOString(),
      },
    };
  }

  return {
    available() {
      if (runtimeConfig.ai.routingMode === "smart") return true;
      return apiProviderOrder(runtimeConfig).includes(runtimeConfig.ai.provider);
    },

    label() {
      return runtimeConfig.ai.routingMode === "smart" ? "智能路由" : providerLabel(runtimeConfig.ai.provider);
    },

    statusSnapshot() {
      if (!statusCache) return null;
      return { ...statusCache.value, checkedAt: new Date(statusCache.at).toISOString(), stale: Date.now() - statusCache.at >= 30_000 };
    },

    async status({ refresh = false } = {}) {
      if (!refresh && statusCache && Date.now() - statusCache.at < 30_000) return statusCache.value;
      if (!refresh && statusInFlight) return statusInFlight;
      statusInFlight = (async () => {
      const ids = ["opencode", "codex", "ollama", "deepseek", "openai", "claude"];
      const providers = await Promise.all(ids.map(async (id) => {
        try {
          const provider = await adapters[id].status(refresh);
          return {
            id,
            label: providerLabel(id),
            installed: Boolean(provider.installed),
            ready: Boolean(provider.ready),
            authenticated: Boolean(provider.authenticated),
            version: provider.version || "",
            detail: provider.detail || "",
            models: Array.isArray(provider.models) ? provider.models : [],
          };
        }
        catch (error) { return { id, label: providerLabel(id), installed: false, ready: false, authenticated: false, version: "", detail: error?.message || String(error), models: [] }; }
      }));
      const general = runtimeConfig.ai.routingMode === "smart" ? ["opencode", "codex", ...apiProviderOrder(runtimeConfig), "local"] : [runtimeConfig.ai.provider, "local"];
      const sensitive = runtimeConfig.ai.routingMode === "smart" ? ["codex", ...apiProviderOrder(runtimeConfig), "local"] : [runtimeConfig.ai.provider, "local"];
      const value = {
        mode: runtimeConfig.ai.routingMode,
        modeLabel: runtimeConfig.ai.routingMode === "smart" ? "智能免费优先" : "兼容现有配置",
        routes: { general, sensitive },
        providers,
        privacy: "邮件分类与回复草稿不会发送给 OpenCode 免费模型；钉钉工作信号按普通内容策略处理。",
        codex: { model: runtimeConfig.ai.codex.model || "账号默认模型", reasoningEffort: runtimeConfig.ai.codex.reasoningEffort || "medium" },
      };
      statusCache = { at: Date.now(), value };
      return value;
      })();
      try { return await statusInFlight; }
      finally { statusInFlight = null; }
    },

    async classifyOutlookEmail(message) {
      const sender = message.sender || message.from?.emailAddress?.name || message.from?.emailAddress?.address || "未知";
      return execute({
        kind: "email.classify", sensitivity: "sensitive", system: reliableClassifierPromptSystem,
        user: reliableClassifierPromptUser({ subject: message.subject, sender, text: message.text || message.bodyText || "" }),
        schema: OUTLOOK_CLASSIFICATION_SCHEMA, validator: outlookClassification,
        fallback: () => ({
          queue: "uncertain", actionType: "other", actionText: "请人工确认邮件分类", dueAt: null,
          dueSource: "none", priority: "P2", priorityReason: "AI 来源不可用，需人工确认", confidence: 0,
          summary: message.subject || "邮件等待人工确认",
        }),
      });
    },

    async analyzeDingtalkMessage(message) {
      const context = (message.context || []).map((item) => `${item.sender_name || "成员"}：${item.content || ""}`).join("\n").slice(-6000);
      return execute({
        // 用户已选择复用系统“普通内容”策略：OpenCode 优先，失败后由 Codex CLI 兜底。
        kind: "dingtalk.message.classify", sensitivity: "general",
        system: "你是个人工作台的工作信号研判器。只判断是否需要当前用户行动；普通同步、寒暄、机器人广播和他人任务不得生成行动。对有效工作消息输出 signal：标题、通俗结论、核心事实、可执行步骤、当前证据消息 ID、可选关联对象和可合并的已有信号 ID。只能选输入给出的候选 ID，不可杜撰。mergeSignalId 仅在同一议题且 mergeConfidence>=90 时填写。",
        user: JSON.stringify({ sender: message.sender_name, content: message.content, sentAt: message.sent_at, conversation: message.conversation_title, mentionScope: message.mention_scope, context, signalCandidates: message.signalCandidates || [], associationCandidates: message.associationCandidates || [] }),
        schema: DINGTALK_MESSAGE_SCHEMA, validator: dingtalkMessage,
        fallback: () => ({
          classification: "uncertain", summary: message.content?.slice(0, 120) || "钉钉消息待确认", actionText: "请人工确认是否需要处理", dueDate: null, priority: "P2", confidence: 0, assigneeSelf: false,
          draftTitle: message.content?.slice(0, 40) || "处理钉钉消息", draftNote: message.content?.slice(0, 200) || "", draftDueDate: null, draftPriority: "P2", draftRationale: "AI 来源不可用，草稿需人工确认",
        }),
      });
    },

    async classifyEmails(emails) {
      return execute({
        kind: "email.classify.batch", sensitivity: "sensitive", system: classifyEmailsSystemPrompt,
        user: formatEmailsForClassification(emails), schema: EMAIL_LIST_SCHEMA, validator: emailList,
        fallback: () => ({ items: emails.map((email) => ({
          id: String(email.id), needs_action: false, reason: "AI 来源不可用，请人工确认", confidence: 0,
          summary: email.subject || "待确认邮件", action: "", priority: "low", priorityReason: "尚未完成智能判断",
        })) }),
      });
    },

    async analyzeReports(reports) {
      return execute({
        kind: "team.analyze", sensitivity: "general", system: analyzeReportsSystemPrompt,
        user: formatReportsForAnalysis(reports), schema: REPORT_ANALYSIS_SCHEMA, validator: reportAnalysis, temperature: 0.4,
        fallback: () => ({ teamSummary: `已按成员整理 ${reports.length} 份日志`, members: reports.map((report) => ({
          userId: report.user_id == null ? null : String(report.user_id), name: report.user_name || "未知成员",
          summary: compactReportSummary(report), blockers: [], reviewItems: [],
        })) }),
      });
    },

    async weeklySummary(dailyReports) {
      return execute({
        kind: "report.weekly", sensitivity: "general", system: weeklySummarySystemPrompt,
        user: formatDailyReportsForWeeklySummary(dailyReports), schema: WEEKLY_SCHEMA, validator: weekly, temperature: 0.4,
        fallback: () => ({ highlights: [], risks: [], coordination: [], nextWeek: [], narrative: `已基于 ${dailyReports.length} 份日报生成本地汇总。` }),
      });
    },

    async summarizeReview(review) {
      return execute({
        kind: "review.summary", sensitivity: "general", system: summarizeReviewSystemPrompt,
        user: JSON.stringify(review), schema: REVIEW_SCHEMA, validator: reviewSummary,
        fallback: () => ({ did: review?.did ? [String(review.did)] : [], learned: review?.learned ? [String(review.learned)] : [], mistake: review?.mistake ? [String(review.mistake)] : [], mood: String(review?.mood || "平稳") }),
      });
    },

    async dailySuggestion(summary, feedback = "") {
      return execute({
        kind: "dashboard.suggestion", sensitivity: "general", system: buildDailySuggestionSystemPrompt(feedback),
        user: JSON.stringify(summary), schema: SUGGESTION_SCHEMA, validator: suggestion,
        fallback: () => localDailySuggestion(summary),
      });
    },

    async draftReply(ctx) {
      return execute({
        kind: "email.draft", sensitivity: "sensitive", system: buildDraftReplySystemPrompt(ctx.tone),
        user: JSON.stringify(ctx), schema: DRAFT_SCHEMA, validator: draft,
        fallback: () => localDraft(ctx.tone),
      });
    },
  };
}

export const ai = createAiService();
