import { config } from "./config.mjs";
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
} from "./prompts/index.mjs";

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
    const system = classifyEmailsSystemPrompt;
    const user = formatEmailsForClassification(emails);
    return chatJson(system, user);
  },

  async analyzeReports(reports) {
    const system = analyzeReportsSystemPrompt;
    const user = formatReportsForAnalysis(reports);
    return chatJson(system, user, { temperature: 0.4 });
  },

  async weeklySummary(dailyReports) {
    const system = weeklySummarySystemPrompt;
    const user = formatDailyReportsForWeeklySummary(dailyReports);
    return chatJson(system, user, { temperature: 0.4 });
  },

  async summarizeReview(review) {
    const system = summarizeReviewSystemPrompt;
    const user = JSON.stringify(review);
    return chatJson(system, user);
  },

  async dailySuggestion(summary, feedback = "") {
    const system = buildDailySuggestionSystemPrompt(feedback);
    const user = JSON.stringify(summary);
    return chatJson(system, user);
  },

  // 生成邮件回复草稿：基于邮件内容、AI 分类建议与主管待办上下文起草回复正文
  async draftReply(ctx) {
    const system = buildDraftReplySystemPrompt(ctx.tone);
    const user = JSON.stringify(ctx);
    return chatJson(system, user);
  },
};
