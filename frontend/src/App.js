import React, { useState } from 'react';
import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { Approvals } from './pages/Approvals';
import { Settings } from './pages/Settings';
import { NavLink } from './components/UI';

const navItems = [
  { path: '/', label: 'Dashboard' },
  { path: '/approvals', label: 'Approvals' },
  { path: '/settings', label: 'Settings' },
];

export default function App() {
  const location = useLocation();

  return (
    <div style={{ minHeight: '100vh' }}>
      <header style={{ background: 'var(--card-bg)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 100 }}>
        <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px' }}>
          <Link to="/" style={{ fontSize: '20px', fontWeight: 700, color: 'var(--primary)', textDecoration: 'none' }}>
            ☁️ Cloud Cost Janitor
          </Link>
          <nav className="nav">
            {navItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                active={location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path))}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/approvals/*" element={<Approvals />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>

      <footer style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', borderTop: '1px solid var(--border)', marginTop: '40px' }}>
        Cloud Cost Janitor v1.0.0 • Built with React & AWS
      </footer>
    </div>
  );
}