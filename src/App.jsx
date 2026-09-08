import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/AppShell.jsx";
import Overview2Page from "./pages/Overview2Page.jsx";
const EmailsPage = lazy(() => import("./pages/EmailsPage.jsx"));
const ActionsPage = lazy(() => import("./pages/ActionsPage.jsx"));
const TeamPage = lazy(() => import("./pages/TeamPage.jsx"));
const ReportsPage = lazy(() => import("./pages/ReportsPage.jsx"));
const CalendarPage = lazy(() => import("./pages/CalendarPage.jsx"));
const AiHotPage = lazy(() => import("./pages/AiHotPage.jsx"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage.jsx"));
const SystemPage = lazy(() => import("./pages/SystemPage.jsx"));
const MeetingsPage = lazy(() => import("./pages/MeetingsPage.jsx"));
const DwsAgentPage = lazy(() => import("./pages/DwsAgentPage.jsx"));

export default function App() {
  return (
    <AppShell>
      <Suspense fallback={<div className="spinner">加载中…</div>}><Routes>
        <Route path="/" element={<Overview2Page />} />
        <Route path="/actions" element={<ActionsPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/ai-hot" element={<AiHotPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/dws" element={<DwsAgentPage />} />
        <Route path="/settings" element={<SystemPage />} />
        <Route path="/mail-setup" element={<EmailsPage />} />
        <Route path="/overview2" element={<Navigate to="/" replace />} />
        <Route path="/emails" element={<Navigate to="/actions?tab=email" replace />} />
        <Route path="/emails2" element={<Navigate to="/actions?tab=email" replace />} />
        <Route path="/todos" element={<Navigate to="/actions?tab=tasks" replace />} />
        <Route path="/review" element={<Navigate to="/reports?tab=review" replace />} />
        <Route path="/daily" element={<Navigate to="/reports?tab=daily" replace />} />
        <Route path="/weekly" element={<Navigate to="/reports?tab=weekly" replace />} />
        <Route path="/team-load" element={<Navigate to="/team?tab=pulse" replace />} />
        <Route path="/system" element={<Navigate to="/settings" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></Suspense>
    </AppShell>
  );
}
