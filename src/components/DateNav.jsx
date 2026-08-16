import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";

// 本地时区安全地加减天数，返回 YYYY-MM-DD。
// 注意：不能用 new Date(d+"T00:00:00") 再 toISOString().slice(0,10)，
// 因为 toISOString 是 UTC，UTC+8 下本地午夜会偏移回前一天，导致 ±1 天错乱。
export function shiftDate(d, delta) {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(y, m - 1, day); // 本地午夜
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// 统一的「前一天 / 后一天」日期导航。所有带日期查询的页面都应复用本组件，
// 避免出现各页面重复实现、时区处理不一致的同类 bug。
export default function DateNav({ date, onChange, className = "" }) {
  if (!date) return null;
  return (
    <div
      className={"date-nav " + className}
      style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
    >
      <button type="button" className="btn sm" onClick={() => onChange(shiftDate(date, -1))}>
        <IconChevronLeft size={16} stroke={1.75} /> 前一天
      </button>
      <input
        type="date"
        value={date}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        style={{ width: 160 }}
      />
      <button type="button" className="btn sm" onClick={() => onChange(shiftDate(date, 1))}>
        后一天 <IconChevronRight size={16} stroke={1.75} />
      </button>
    </div>
  );
}
