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

    async status({ refresh = false } = {}) {
      if (!refresh && statusCache && Date.now() - statusCache.at < 30_000) return statusCache.value;
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
        privacy: "邮件分类和回复草稿不会发送给 OpenCode 免费模型。",
        codex: { model: runtimeConfig.ai.codex.model || "账号默认模型", reasoningEffort: runtimeConfig.ai.codex.reasoningEffort || "medium" },
      };
      statusCache = { at: Date.now(), value };
      return value;
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
