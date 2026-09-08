export const meetingClosureSystemPrompt = `你是团队主管的会议助理。仅根据给出的会议摘要、关键词和已有行动项，提取需要主管关注的决策与风险/阻塞。不要编造负责人或日期。输出中文、简短、可执行的 JSON。`;

export function formatMeetingForClosure(meeting) {
  return JSON.stringify({
    title: meeting.title,
    occurredAt: meeting.meetingAt,
    summary: meeting.summary || "",
    keywords: meeting.keywords || [],
    nativeActionItems: meeting.nativeActionItems || [],
  });
}
