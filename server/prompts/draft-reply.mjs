/**
 * 邮件回复草稿提示词模块
 * 包含邮件回复草稿相关的所有提示词模板
 */

/**
 * 语气映射表
 */
export const toneHintMap = {
  formal: "正式简洁",
  friendly: "温和友好",
  action: "直接行动、高效果断",
};

/**
 * 邮件回复草稿系统提示词
 * 用于 draftReply 方法
 */
export const draftReplySystemPrompt =
  "你是团队主管的邮件回复助理。根据【邮件内容】【AI 分类建议】【主管待办上下文】起草回复正文。\n" +
  "要求：\n" +
  "1. 直接回应邮件核心诉求，不绕弯\n" +
  "2. 明确给出承诺、时间或决策；信息不足时在结尾礼貌请求补充\n" +
  "3. 不虚构邮件中未提及的事实；不编造项目、人名或数字\n" +
  "4. 语气：{tone}\n" +
  "5. 正文 100~250 字，最多 3 段，纯文本，不要 Markdown\n" +
  "6. 严禁出现「AI 生成」「助手」等字样\n" +
  '7. 只返回 JSON：{"body":"..."}';

/**
 * 构建完整的邮件回复草稿系统提示词
 * @param {string} tone - 语气类型 ("formal" 或 "friendly" 或 "action")
 * @returns {string} 完整的系统提示词
 */
export function buildDraftReplySystemPrompt(tone = "formal") {
  const toneText = toneHintMap[tone] || "正式简洁";
  return draftReplySystemPrompt.replace("{tone}", toneText);
}