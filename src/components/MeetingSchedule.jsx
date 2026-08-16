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
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function durationMin(start, end) {
  const ms = new Date(end) - new Date(start);
  return Math.max(0, Math.round(ms / 60000));
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

  return (
    <div className="meeting-schedule">
      <div className={`meeting-feature-card ${isCurrent ? "is-current" : ""}`}>
        <div className="meeting-feature-card__top">
          <span className="meeting-feature-card__time">
            {fmtTime(featured.start_at)}–{fmtTime(featured.end_at)}
          </span>
          {isCurrent ? (
            <span className="pill red">进行中</span>
          ) : !live ? (
            <span className="pill gray">当日</span>
          ) : upcoming.length ? (
            <span className="pill purple">即将开始</span>
          ) : (
            <span className="pill gray">已结束</span>
          )}
        </div>

        <div className="meeting-feature-card__title">{featured.title}</div>

        <div className="meeting-feature-card__meta">
          {featured.location ? (
            isOnline ? (
              <span className="meeting-feature-card__loc"><IconVideo size={15} stroke={1.75} /> 线上会议</span>
            ) : (
              <span className="meeting-feature-card__loc"><IconMapPin size={15} stroke={1.75} /> {featured.location}</span>
            )
          ) : (
            <span className="meeting-feature-card__loc"><IconClock size={15} stroke={1.75} /> 约 {durMin} 分钟</span>
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
              const locLabel = online ? "线上" : m.location;
              return (
                <div className="meeting-compact-row" key={m.id || `m-${i}`}>
                  <span className="meeting-compact-row__time">{fmtTime(m.start_at)}</span>
                  <span className="meeting-compact-row__title">{m.title}</span>
                  {locLabel && (
                    <span className="meeting-compact-row__loc">
                      {online ? <IconVideo size={13} stroke={1.75} /> : <IconMapPin size={13} stroke={1.75} />}
                      {locLabel}
                    </span>
                  )}
                  {m.organizer && (
                    <span className="meeting-compact-row__org">
                      <IconUser size={13} stroke={1.75} />
                      {m.organizer}
                    </span>
                  )}
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
