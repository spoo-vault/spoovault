import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { HeroUIProvider } from "@heroui/react";
import { Toaster } from "react-hot-toast";
import { captureError } from "./services/telemetry.service";
import { SessionLockGate } from "./components/SessionLockGate";

const LandingPage = lazy(() => import("./pages/LandingPage"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const AnalyticsDashboard = lazy(() => import("./pages/AnalyticsDashboard"));
const Vaults = lazy(() => import("./pages/Vaults"));
const Documents = lazy(() => import("./pages/Documents"));
const NFTGallery = lazy(() => import("./pages/NFTGallery"));
const Profile = lazy(() => import("./pages/Profile"));
const AccessCenter = lazy(() => import("./pages/AccessCenter"));
const DocsPage = lazy(() => import("./pages/DocsPage"));
const AppLayout = lazy(() => import("./layouts/AppLayout"));

function App() {
  useEffect(() => {
    try {
      const stored = localStorage.getItem("spoovault-profile");
      if (stored) {
        const parsed = JSON.parse(stored) as { theme?: string };
        if (parsed.theme) {
          document.documentElement.setAttribute("data-theme", parsed.theme);
        }
      }
    } catch {
      // Ignore profile parse errors
    }
  }, []);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      captureError("window.error", event.error || event.message || "Unhandled window error", {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      captureError("window.unhandledrejection", event.reason || "Unhandled promise rejection");
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return (
    <HeroUIProvider>
      <Router>
        <Suspense
          fallback={
            <div className="min-h-screen flex items-center justify-center bg-[#040306] text-gray-300">
              <div className="text-sm tracking-wide">Loading SpooVault...</div>
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route element={<AppLayout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/analytics" element={<AnalyticsDashboard />} />
              <Route path="/vaults" element={<Vaults />} />
              <Route path="/documents" element={<Documents />} />
              <Route path="/access" element={<AccessCenter />} />
              <Route path="/nfts" element={<NFTGallery />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/docs" element={<DocsPage />} />
            </Route>
          </Routes>
        </Suspense>
        <Toaster
          position="top-right"
          toastOptions={{
            className: "bg-gray-900 text-white border border-gray-800",
            style: {
              background: "hsl(var(--background))",
              color: "hsl(var(--foreground))",
              border: "1px solid hsl(var(--border))",
            },
          }}
        />
        <SessionLockGate />
      </Router>
    </HeroUIProvider>
  );
}

export default App;

