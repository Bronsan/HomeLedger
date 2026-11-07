import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { isTauri } from "./api/client";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Spinner, ToastProvider } from "./components/ui";
import { AuthProvider, useAuth } from "./hooks/auth";
import { entryStore, serviceSession } from "./lib/service";
import { AuditPage } from "./pages/Audit";
import { CategoriesPage } from "./pages/Categories";
import { ConnectPage } from "./pages/Connect";
import { DashboardPage } from "./pages/Dashboard";
import { ItemDetailPage } from "./pages/ItemDetail";
import { ItemFormPage } from "./pages/ItemForm";
import { ItemsPage } from "./pages/Items";
import { JoinPage } from "./pages/Join";
import { LabelsPage } from "./pages/Labels";
import { LocationsPage } from "./pages/Locations";
import { ArchivePage } from "./pages/Archive";
import { LoansPage } from "./pages/Loans";
import { Login } from "./pages/Login";
import { MaintenancePage } from "./pages/Maintenance";
import { MembersPage } from "./pages/Members";
import { ScanPage } from "./pages/Scan";
import { SettingsPage } from "./pages/Settings";
import { WelcomePage } from "./pages/Welcome";

function Booting() {
  return (
    <div style={{ height: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "var(--radius-xs)",
            background: "var(--brand)",
            display: "grid",
            placeItems: "center",
            color: "var(--on-brand)",
          }}
        >
          <Spinner size={18} />
        </div>
        <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>正在打开家庭账本…</span>
      </div>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Booting />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

/**
 * Turns "cannot reach the server" into a screen instead of an empty app.
 *
 * Checked before routing on purpose: `/items` behind a dead server would render
 * an empty list, which reads as "my stuff is gone" rather than "my server is
 * off". The gate only applies to server mode — local and sync modes never talk
 * to a server on the read path.
 */
function ConnectionGate({ children }: { children: React.ReactNode }) {
  const { connectionError, loading } = useAuth();
  const loc = useLocation();
  if (loc.pathname === "/welcome") return <>{children}</>;
  if (loading) return <Booting />;
  if (connectionError) return <ConnectPage />;
  return <>{children}</>;
}

/**
 * 安装版第一次启动必须先在欢迎页选“本机 / 联网账号”，不能直接落进账本。
 * 联网账号每次冷启动还要向服务服务器验证一次；验证标记只存在模块内存。
 * 浏览器版不经过这道门，继续用原来的服务器登录流程。
 */
function EntryGate({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  if (!isTauri()) return <>{children}</>;
  const entry = entryStore.get();
  const needsEntry = !entry || (entry === "online" && !serviceSession.verified());
  if (needsEntry && loc.pathname !== "/welcome") {
    return <Navigate to="/welcome" replace />;
  }
  if (!needsEntry && loc.pathname === "/welcome") {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <ScrollToTop />
            <EntryGate>
              <ConnectionGate>
                <Routes>
                  <Route path="/welcome" element={<WelcomePage />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/join" element={<JoinPage />} />
                  <Route
                    element={
                      <Protected>
                        <AppShell />
                      </Protected>
                    }
                  >
                    <Route path="/" element={<DashboardPage />} />
                    <Route path="/items" element={<ItemsPage />} />
                    <Route path="/items/new" element={<ItemFormPage />} />
                    <Route path="/items/:id" element={<ItemDetailPage />} />
                    <Route path="/items/:id/edit" element={<ItemFormPage />} />
                    <Route path="/scan" element={<ScanPage />} />
                    <Route path="/labels" element={<LabelsPage />} />
                    <Route path="/maintenance" element={<MaintenancePage />} />
                    <Route path="/loans" element={<LoansPage />} />
                    <Route path="/locations" element={<LocationsPage />} />
                    <Route path="/categories" element={<CategoriesPage />} />
                    <Route path="/archive" element={<ArchivePage />} />
                    <Route path="/members" element={<MembersPage />} />
                    <Route path="/audit" element={<AuditPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Route>
                </Routes>
              </ConnectionGate>
            </EntryGate>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}