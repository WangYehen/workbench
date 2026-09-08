import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  IconLayoutDashboard,
  IconBolt,
  IconUsers,
  IconCalendarEvent,
  IconFileAnalytics,
  IconFlame,
  IconRoute,
  IconSettings,
  IconMenu,
  IconCommand,
  IconMessageCircle2,
} from "@tabler/icons-react";

const NAV_GROUPS = [
  {
    title: "工作区",
    items: [
      { to: "/", label: "今日指挥台", Icon: IconLayoutDashboard },
      { to: "/actions", label: "行动中心", Icon: IconBolt },
      { to: "/team", label: "团队", Icon: IconUsers },
      { to: "/calendar", label: "日历", Icon: IconCalendarEvent },
      { to: "/projects", label: "项目", Icon: IconRoute },
      { to: "/dws", label: "DWS Agent", Icon: IconMessageCircle2 },
      { to: "/reports", label: "汇报", Icon: IconFileAnalytics },
      { to: "/settings", label: "设置", Icon: IconSettings },
    ],
  },
  { title: "工具", items: [{ to: "/ai-hot", label: "AI 热点", Icon: IconFlame }] },
];

export function AppShell({ children }) {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><IconCommand size={19} stroke={1.8} /></span>
          <div>
            <div className="brand-name">个人AI工作台</div>
            <small>Personal AI Workbench</small>
          </div>
        </div>
        <nav className="nav">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.title}>
              <div className="nav-group__title">{group.title}</div>
              {group.items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === "/"} onClick={() => setNavOpen(false)}>
                  <n.Icon size={20} stroke={1.75} />
                  <span>{n.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} />}
      <main className="main">
        <button className="nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-label="切换导航菜单">
          <IconMenu size={20} stroke={1.75} />
        </button>
        {children}
      </main>
    </div>
  );
}
