/**
 * 周报生成提示词模块
 * 包含周报生成相关的所有提示词模板
 */

/**
 * 周报生成系统提示词
 * 用于 weeklySummary 方法
 */
export const weeklySummarySystemPrompt =
  "基于一周的每日工作回顾，生成团队周报。包含：本周关键进展、主要风险与阻塞、需要协调的事项、下周重点。" +
  '返回 JSON：{"highlights":[".."],"risks":[".."],"coordination":[".."],"nextWeek":[".."],"narrative":"一段总结"}';

/**
 * 格式化周报生成请求数据
 * @param {Array} dailyReports - 每日报告列表
 * @returns {string} JSON字符串
 */
export function formatDailyReportsForWeeklySummary(dailyReports) {
  return JSON.stringify(dailyReports.map((d) => ({ date: d.report_date, content: d.content_json })));
}