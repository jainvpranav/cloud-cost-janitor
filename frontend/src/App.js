import React, { useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';

import { AppFooter, ErrorBoundary, Sidebar, Topbar, useDrawer } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Findings } from './pages/Findings';
import { Approvals } from './pages/Approvals';
import { Insights } from './pages/Insights';
import { Docs } from './pages/Docs';
import { Settings } from './pages/Settings';
import { NotFound } from './pages/NotFound';
import { useApprovals, useConfig } from './hooks/useApi';

function Shell() {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useDrawer();
  const [rail, setRail] = useState(false);

  // The approval count drives the sidebar badge and topbar bell, so it is
  // fetched once at the shell level and shared by every page.
  const { approvals } = useApprovals({ status: 'PENDING', limit: 200, pollMs: 5000 });
  const { data: config } = useConfig();
  const pendingCount = approvals.filter((a) => a.status === 'PENDING').length;

  // Lightweight pending count for the sidebar's "Insights" badge.
  const openHint = pendingCount;

  useEffect(() => {
    setDrawerOpen(false);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname, setDrawerOpen]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setRail((r) => !r);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app ${rail ? 'rail' : ''} ${drawerOpen ? 'drawer-open' : ''}`}>
      <Sidebar
        pendingApprovals={pendingCount}
        openCount={openHint}
        rail={rail}
        onNavigate={() => setDrawerOpen(false)}
      />
      {drawerOpen ? <div className="sidebar-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" /> : null}

      <div className="app-main">
        <Topbar
          onMenu={() => setDrawerOpen(true)}
          pendingApprovals={pendingCount}
          onNavigate={() => setDrawerOpen(false)}
          config={config}
        />
        <main className="grow">
          <ErrorBoundary key={location.pathname}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/insights" element={<Insights />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/approvals/*" element={<Approvals />} />
              <Route path="/findings" element={<Findings />} />
              <Route path="/docs" element={<Docs />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </ErrorBoundary>
        </main>
        <AppFooter />
      </div>
    </div>
  );
}

export default function App() {
  return <Shell />;
}
