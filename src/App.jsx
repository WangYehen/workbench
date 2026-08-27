import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/AppShell.jsx";
import Overview2Page from "./pages/Overview2Page.jsx";
import EmailsPage from "./pages/EmailsPage.jsx";
import ActionsPage from "./pages/ActionsPage.jsx";
import TeamPage from "./pages/TeamPage.jsx";
import ReportsPage from "./pages/ReportsPage.jsx";
import CalendarPage from "./pages/CalendarPage.jsx";
import AiHotPage from "./pages/AiHotPage.jsx";
import ProjectsPage from "./pages/ProjectsPage.jsx";
import SystemPage from "./pages/SystemPage.jsx";

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Overview2Page />} />
        <Route path="/actions" element={<ActionsPage />} />
        <Route path="/team" element={<TeamPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/ai-hot" element={<AiHotPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
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
      </Routes>
    </AppShell>
  );
}
