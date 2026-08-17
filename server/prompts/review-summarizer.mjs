/**
 * 复盘总结提示词模块
 * 包含复盘总结相关的所有提示词模板
 */

/**
 * 复盘总结系统提示词
 * 用于 summarizeReview 方法
 */
export const summarizeReviewSystemPrompt =
  '将主管的每日复盘整理为结构化要点。返回 JSON：{"did":[".."],"learned":[".."],"mistake":[".."],"mood":"情绪标签"}';