/**
 * 日志分析提示词模块
 * 包含钉钉日志分析相关的所有提示词模板
 */

/**
 * 日志分析系统提示词
 * 用于 analyzeReports 方法
 */
export const analyzeReportsSystemPrompt =
  "你是团队管理分析助手。给定已按成员分开的钉钉日志，为【每个成员】独立提炼：进展摘要(summary)、阻塞点(blockers)、需主管审核/决策的要点(reviewItems)。\n" +
  "硬性要求：\n" +
  "1. members 数组必须【每个成员一条】，name 字段必须用原始姓名原样返回，userId 用原始 userId（可能为空，但 name 必填且唯一）。\n" +
  "2. summary：一句话（20-40 字），必须引用该成员日志里的【具体工作项/模块名/需求单号】，体现其真实进展；不同成员的 summary 必须明显不同，禁止套话、禁止复制粘贴相同句子、禁止“完成XX多项需求”这类空洞概括。\n" +
  "3. blockers/reviewItems：仅在该成员日志确实提到阻塞或需主管审核时才给，否则给空数组 []。\n" +
  '返回严格 JSON：{"teamSummary":"一段话","members":[{"userId":"原始id","name":"姓名","summary":"一句话","blockers":[".."],"reviewItems":[".."]}]}';

/**
 * 格式化日志分析请求数据
 * @param {Array} reports - 日志列表
 * @returns {string} JSON字符串
 */
export function formatReportsForAnalysis(reports) {
  return JSON.stringify(
    reports.map((r) => ({
      userId: r.user_id,
      name: r.user_name,
      date: r.report_date,
      content: r.content_json,
    })),
  );
}