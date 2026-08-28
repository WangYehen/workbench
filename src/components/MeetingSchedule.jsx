import {
  IconCalendarEvent,
  IconMapPin,
  IconVideo,
  IconClock,
  IconUser,
} from "@tabler/icons-react";

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

function durationMin(start, end) {
  const ms = new Date(end) - new Date(start);
  return Math.max(0, Math.round(ms / 60000));
}

function meetingStatus(meeting, now, live) {
  // 非当天视图中的会议均属于历史快照，明确标记为已结束，避免“当日”造成误解。
  if (!live) return { key: "ended", label: "已结束" };
  if (meeting._start <= now && meeting._end >= now) return { key: "live", label: "进行中" };
  if (meeting._start > now) return { key: "upcoming", label: "未开始" };
  return { key: "ended", label: "已结束" };
}

export default function MeetingSchedule({ meetings, onViewCalendar, live = true }) {
  if (!meetings || !meetings.length) {
    return (
      <div className="meeting-empty">
        <div className="meeting-empty__icon"><IconCalendarEvent size={20} stroke={1.75} /></div>
        <div>
          <div className="title">今日无会议</div>
          <div className="sub">一块不被打断的时间，可深度推进要事，或写今日复盘</div>
        </div>
      </div>
    );
  }

  const now = new Date();
  const withTimes = meetings.map((m) => {
    const start = new Date(m.start_at);
    const end = m.end_at ? new Date(m.end_at) : new Date(start.getTime() + 30 * 60000);
    return { ...m, _start: start, _end: end };
  });

  const current = live ? withTimes.find((m) => m._start <= now && m._end >= now) : null;
  const upcoming = live ? withTimes.filter((m) => m._start > now).sort((a, b) => a._start - b._start) : [];
  const featured = current || upcoming[0] || withTimes[0];
  const rest = withTimes
    .filter((m) => m !== featured)
    .sort((a, b) => a._start - b._start)
    .slice(0, 3);

  const isCurrent = current === featured;
  const total = featured._end - featured._start;
  const elapsed = isCurrent ? now - featured._start : 0;
  const pct = isCurrent ? Math.max(0, Math.min(100, (elapsed / total) * 100)) : 0;
  const isOnline = featured.location && /^https?:\/\//i.test(featured.location);
  const durMin = durationMin(featured._start, featured._end);
  const featuredStatus = meetingStatus(featured, now, live);

  return (
    <div className="meeting-schedule">
      <div className={`meeting-feature-card ${isCurrent ? "is-current" : ""}`}>
        <div className="meeting-feature-card__top">
          <span className="meeting-feature-card__time">
            {fmtTime(featured.start_at)}–{fmtTime(featured._end.toISOString())}
          </span>
          <span className={`meeting-status meeting-status--${featuredStatus.key}`}>{featuredStatus.label}</span>
          {featured.source === "dingtalk" && <span className="pill blue">钉钉</span>}
        </div>

        <div className="meeting-feature-card__title">{featured.title}</div>

        <div className="meeting-feature-card__meta">
          <span className="meeting-feature-card__loc"><IconClock size={15} stroke={1.75} /> 约 {durMin} 分钟</span>
          {featured.location ? (
            isOnline ? (
              <span className="meeting-feature-card__loc"><IconVideo size={15} stroke={1.75} /> 线上会议</span>
            ) : (
              <span className="meeting-feature-card__loc"><IconMapPin size={15} stroke={1.75} /> {featured.location}</span>
            )
          ) : (
            <span className="meeting-feature-card__loc"><IconMapPin size={15} stroke={1.75} /> 地点未填写</span>
          )}
          {featured.organizer && <span className="meeting-feature-card__org">组织者 {featured.organizer}</span>}
        </div>

        {isCurrent && (
          <div className="meeting-feature-card__bar">
            <span style={{ width: `${pct}%` }} />
          </div>
        )}

        {isOnline && (
          <a className="btn sm primary meeting-feature-card__join" href={featured.location} target="_blank" rel="noreferrer">
            加入会议
          </a>
        )}
      </div>

      {rest.length > 0 && (
        <>
          <div className="meeting-compact-label">今日剩余 {rest.length} 场</div>
          <div className="meeting-compact-list">
            {rest.map((m, i) => {
              const online = m.location && /^https?:\/\//i.test(m.location);
              const locLabel = online ? "线上" : (m.location || "地点未填写");
              const status = meetingStatus(m, now, live);
              return (
                <div className="meeting-compact-row" key={`${m.id || "meeting"}-${i}`}>
                  <span className="meeting-compact-row__time">{fmtTime(m.start_at)}</span>
                  <span className="meeting-compact-row__title">{m.title}</span>
                  <span className="meeting-compact-row__loc">
                    {online ? <IconVideo size={13} stroke={1.75} /> : <IconMapPin size={13} stroke={1.75} />}
                    {locLabel}
                  </span>
                  {m.organizer && (
                    <span className="meeting-compact-row__org">
                      <IconUser size={13} stroke={1.75} />
                      {m.organizer}
                    </span>
                  )}
                  <span className={`meeting-status meeting-status--${status.key}`}>{status.label}</span>
                  <span className="meeting-compact-row__dur">{durationMin(m._start, m._end)} 分</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {onViewCalendar && (
        <button className="btn sm ghost meeting-view-cal" onClick={onViewCalendar}>
          查看日历（{meetings.length}）→
        </button>
      )}
    </div>
  );
}
