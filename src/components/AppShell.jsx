import { NavLink } from "react-router-dom";
import {
  IconLayoutDashboard,
  IconMail,
  IconUsers,
  IconCalendarEvent,
  IconChecklist,
  IconFileText,
  IconNotebook,
  IconFlame,
  IconRoute,
  IconUsersGroup,
  IconCalendarWeek,
  IconSettings,
} from "@tabler/icons-react";

// 侧边栏导航：严格按 README「页面地图」分 4 组，顺序与标签一致。
const NAV_GROUPS = [
  {
    title: "聚合首页",
    items: [{ to: "/", label: "概览", Icon: IconLayoutDashboard }],
  },
  {
    title: "信息源",
    items: [
      { to: "/emails", label: "邮件", Icon: IconMail },
      { to: "/team", label: "团队日志", Icon: IconUsers },
      { to: "/calendar", label: "日历", Icon: IconCalendarEvent },
      { to: "/ai-hot", label: "AI 热点", Icon: IconFlame },
    ],
  },
  {
    title: "个人产出",
    items: [
      { to: "/todos", label: "待办", Icon: IconChecklist },
      { to: "/review", label: "复盘", Icon: IconNotebook },
      { to: "/daily", label: "日报", Icon: IconFileText },
      { to: "/weekly", label: "周报", Icon: IconCalendarWeek },
    ],
  },
  {
    title: "管理",
    items: [
      { to: "/projects", label: "项目时间线", Icon: IconRoute },
      { to: "/team-load", label: "团队负载", Icon: IconUsersGroup },
      { to: "/system", label: "系统/接入", Icon: IconSettings },
    ],
  },
];

export function AppShell({ children }) {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"></span>
          <div>
            <div className="brand-name">团队每日工作台</div>
            <small>Team Daily Workbench</small>
          </div>
        </div>
        <nav className="nav">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.title}>
              <div className="nav-group__title">{group.title}</div>
              {group.items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === "/"}>
                  <n.Icon size={20} stroke={1.75} />
                  <span>{n.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
