import { useState, useRef, useEffect, useCallback } from "react";
import { IconChevronUp, IconChevronDown } from "@tabler/icons-react";

/**
 * 自定义日期选择器 — 替代原生 <input type="date">
 * 设计系统对齐：16px 圆角、紫色 accent、Space Grotesk 字体
 */
export function DatePicker({ value, onChange, placeholder = "选择日期" }) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => {
    if (value) { const d = new Date(value + "T00:00:00"); return d.getFullYear(); }
    return new Date().getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    if (value) { const d = new Date(value + "T00:00:00"); return d.getMonth(); }
    return new Date().getMonth();
  });

  const ref = useRef(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // 当 value 变化时同步视图年月
  useEffect(() => {
    if (value) {
      const d = new Date(value + "T00:00:00");
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    }
  }, [value]);

  const today = new Date();
  const todayYMD = ymd(today);

  function ymd(d) {
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun

  const monthNames = ["01","02","03","04","05","06","07","08","09","10","11","12"];

  function selectDay(day) {
    const mm = String(viewMonth + 1).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const selected = `${viewYear}-${mm}-${dd}`;
    onChange(selected);
    setOpen(false);
  }

  function goDeltaMonths(delta) {
    setViewMonth((m) => { const nm = m + delta; if (nm < 0) { setViewYear(y => y - 1); return 11; } if (nm > 11) { setViewYear(y => y + 1); return 0; } return nm; });
  }

  function goToday() {
    onChange(todayYMD);
    setOpen(false);
  }

  // 构建日历网格（42 格：6 行 × 7 列）
  const cells = [];
  // 填充月初空白
  for (let i = 0; i < firstDow; i++) {
    const prevMonth = new Date(viewYear, viewMonth, -i);
    cells.push({ day: prevMonth.getDate(), other: true, ymd: ymd(prevMonth) });
  }
  // 当月天数
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, other: false, ymd: `${viewYear}-${String(viewMonth+1).padStart(2,"0")}-${String(d).padStart(2,"0")}` });
  }
  // 填充月末空白到 42
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) {
    const nextMonth = new Date(viewYear, viewMonth + 1, d);
    cells.push({ day: d, other: true, ymd: ymd(nextMonth) });
  }

  const displayValue = value || "";

  return (
    <div className="date-picker-wrap" ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className="date-picker__trigger"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          border: "1px solid var(--line)", borderRadius: "var(--r-md)",
          padding: "8px 12px", fontSize: "var(--text-body)",
          fontFamily: "inherit", color: "var(--ink)", background: "var(--paper)",
          cursor: "pointer", minWidth: 150, transition: "border-color 0.16s, box-shadow 0.16s",
          outline: "none",
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.boxShadow = "0 0 0 3px var(--accent-ghost)"; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.boxShadow = ""; }}
      >
        <span style={{ flex: 1, textAlign: "left", color: displayValue ? "var(--ink)" : "var(--ink-faint)" }}>
          {displayValue || placeholder}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--ink-faint)", flexShrink: 0 }}>
          <rect x="3" y="4" width="18" height="18" rx="3" ry="3" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </button>

      {open && (
        <>
          <div className="date-picker-overlay" onClick={() => setOpen(false)} />
          <div className="date-picker" style={{ left: 0, top: "calc(100% + 6px)" }}>
            {/* 头部：年月 + 导航 */}
            <div className="date-picker__header">
              <div className="date-picker__year-month">
                <span>{viewYear}</span>
                <span style={{ color: "var(--ink-faint)" }}>/</span>
                <span>{monthNames[viewMonth]}</span>
              </div>
              <div className="date-picker__nav">
                <button type="button" onClick={() => goDeltaMonths(-1)} title="上个月"><IconChevronUp size={16} /></button>
                <button type="button" onClick={() => goDeltaMonths(1)} title="下个月"><IconChevronDown size={16} /></button>
              </div>
            </div>

            {/* 星期头 */}
            <div className="date-picker__grid" style={{ marginBottom: 4 }}>
              {["一","二","三","四","五","六","日"].map((w) => (
                <div key={w} className="date-picker__weekday">{w}</div>
              ))}
            </div>

            {/* 日期网格 */}
            <div className="date-picker__grid">
              {cells.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  className={`date-picker__day${c.other ? " is-other-month" : ""}${c.ymd === todayYMD ? " is-today" : ""}${c.ymd === value ? " is-selected" : ""}`}
                  onClick={() => !c.other && selectDay(c.day)}
                  disabled={c.other}
                >
                  {c.day}
                </button>
              ))}
            </div>

            {/* 底部操作 */}
            <div className="date-picker__footer">
              <button type="button" className="date-picker__clear" onClick={() => { onChange(""); setOpen(false); }}>清除</button>
              <button type="button" className="date-picker__today" onClick={goToday}>今天</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
