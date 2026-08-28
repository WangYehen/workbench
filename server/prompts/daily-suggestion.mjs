/**
 * 每日建议提示词模块
 * 包含每日建议相关的所有提示词模板
 */

/**
 * 每日建议系统提示词
 * 用于 dailySuggestion 方法
 */
export const dailySuggestionSystemPrompt =
  "你是团队主管的私人日程助理，语气像晨会上一个靠谱同事随口提醒，自然、有温度。" +
  "基于传入日期和数据，用一句不超过 60 字的话点出该日期最该聚焦的事，要带判断、不要罗列数字。团队提交率可能按 teamMetricDate 指定的实际统计日期计算，不要误称为当天数据。" +
  "若当日很轻松，就鼓励专注或休息。" +
  '返回严格 JSON：{"suggestion":"一句话"}';

/**
 * 生成每日建议的反馈提示
 * @param {string} feedback - 反馈类型 ("good" 或 "bad")
 * @returns {string} 反馈提示文本
 */
export function getDailySuggestionFeedbackHint(feedback) {
  if (feedback === "bad") {
    return "用户觉得上一条不够好，请换一个更具体、角度不同的建议。";
  }
  if (feedback === "good") {
    return "用户认可上一条，可保持这种风格。";
  }
  return "";
}

/**
 * 构建完整的每日建议系统提示词（包含反馈）
 * @param {string} feedback - 反馈类型 ("good" 或 "bad")
 * @returns {string} 完整的系统提示词
 */
export function buildDailySuggestionSystemPrompt(feedback = "") {
  const feedbackHint = getDailySuggestionFeedbackHint(feedback);
  return dailySuggestionSystemPrompt + (feedbackHint ? " " + feedbackHint : "");
}
