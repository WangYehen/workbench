/**
 * 提示词统一导出模块
 * 集中管理所有 AI 提示词模板，便于维护和修改
 */

// 邮件分类相关提示词
export {
  classifyEmailsSystemPrompt,
  classifierPromptSystem,
  reliableClassifierPromptSystem,
  classifierPromptUser,
  reliableClassifierPromptUser,
  classifySystemMessages,
  formatEmailsForClassification,
} from "./email-classifier.mjs";

// 日志分析相关提示词
export {
  analyzeReportsSystemPrompt,
  formatReportsForAnalysis,
} from "./report-analyzer.mjs";

// 周报生成相关提示词
export {
  weeklySummarySystemPrompt,
  formatDailyReportsForWeeklySummary,
} from "./weekly-summary.mjs";

// 复盘总结相关提示词
export {
  summarizeReviewSystemPrompt,
} from "./review-summarizer.mjs";

// 每日建议相关提示词
export {
  dailySuggestionSystemPrompt,
  getDailySuggestionFeedbackHint,
  buildDailySuggestionSystemPrompt,
} from "./daily-suggestion.mjs";

// 邮件回复草稿相关提示词
export {
  toneHintMap,
  draftReplySystemPrompt,
  buildDraftReplySystemPrompt,
} from "./draft-reply.mjs";

export { dingtalkSignalSystemPrompt } from "./dingtalk-signal.mjs";
export { meetingClosureSystemPrompt, formatMeetingForClosure } from "./meeting-closure.mjs";
export { buildOpenCodeSystemPrompt, buildCodexPrompt } from "./ai-runtime-guard.mjs";
