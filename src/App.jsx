import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { AppShell } from "./components/AppShell.jsx";
import OverviewPage from "./pages/OverviewPage.jsx";
const EmailsPage = lazy(() => import("./pages/EmailsPage.jsx"));
const TodosPage = lazy(() => import("./pages/TodosPage.jsx"));
const DingtalkMessagesPage = lazy(() => import("./pages/DingtalkMessagesPage.jsx"));
const TeamPage = lazy(() => import("./pages/TeamPage.jsx"));
const ReportsPage = lazy(() => import("./pages/ReportsPage.jsx"));
const CalendarPage = lazy(() => import("./pages/CalendarPage.jsx"));
const AiHotPage = lazy(() => import("./pages/AiHotPage.jsx"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage.jsx"));
const SystemPage = lazy(() => import("./pages/SystemPage.jsx"));
const DwsAgentPage = lazy(() => import("./pages/DwsAgentPage.jsx"));

function LegacyActionsRedirect() {
  const [params] = useSearchParams();
  const target = { email: "/mail", dingtalk: "/dingtalk", tasks: "/todo" }[params.get("tab")] || "/todo";
  return <Navigate to={target} replace />;
}

export default function App() {
  return (
    <AppShell>
      <Suspense fallback={<div className="spinner">加载中…</div>}><Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/actions" element={<LegacyActionsRedirect />} />
        <Route path="/todo" element={<TodosPage />} />
        <Route path="/mail" element={<EmailsPage />} />
        <Route path="/dingtalk" element={<DingtalkMessagesPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/ai-hot" element={<AiHotPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/dws" element={<DwsAgentPage />} />
        <Route path="/settings" element={<SystemPage />} />
        <Route path="/mail-setup" element={<EmailsPage />} />
        <Route path="/overview2" element={<Navigate to="/" replace />} />
        <Route path="/emails" element={<Navigate to="/mail" replace />} />
        <Route path="/emails2" element={<Navigate to="/mail" replace />} />
        <Route path="/todos" element={<Navigate to="/todo" replace />} />
        <Route path="/review" element={<Navigate to="/reports?tab=review" replace />} />
        <Route path="/daily" element={<Navigate to="/reports?tab=daily" replace />} />
        <Route path="/weekly" element={<Navigate to="/reports?tab=weekly" replace />} />
        <Route path="/system" element={<Navigate to="/settings" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></Suspense>
    </AppShell>
  );
}
