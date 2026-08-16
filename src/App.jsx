import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/AppShell.jsx";
import OverviewPage from "./pages/OverviewPage.jsx";
import EmailsPage from "./pages/EmailsPage.jsx";
import TeamLogsPage from "./pages/TeamLogsPage.jsx";
import CalendarPage from "./pages/CalendarPage.jsx";
import TodosPage from "./pages/TodosPage.jsx";
import ReviewPage from "./pages/ReviewPage.jsx";
import AiHotPage from "./pages/AiHotPage.jsx";
import ProjectsPage from "./pages/ProjectsPage.jsx";
import TeamLoadPage from "./pages/TeamLoadPage.jsx";
import WeeklyReportPage from "./pages/WeeklyReportPage.jsx";
import DailyReportPage from "./pages/DailyReportPage.jsx";
import SystemPage from "./pages/SystemPage.jsx";

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/emails" element={<EmailsPage />} />
        <Route path="/team" element={<TeamLogsPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/todos" element={<TodosPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/daily" element={<DailyReportPage />} />
        <Route path="/ai-hot" element={<AiHotPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/team-load" element={<TeamLoadPage />} />
        <Route path="/weekly" element={<WeeklyReportPage />} />
        <Route path="/system" element={<SystemPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
