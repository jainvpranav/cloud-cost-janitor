import React, { Component, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { Icon } from './Icons';
import { useTheme } from '../theme/ThemeProvider';
import { initials, relativeTime } from '../lib/format';
import { Button } from './UI';
import { ApproverField, DemoModeChip } from './Live';
import { useApprover } from '../hooks/useApi';

/* ==========================================================================
   Sidebar
   ========================================================================== */

function NavItem({ to, label, icon, count, alert, end, onNavigate }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
      title={label}
    >
      <Icon name={icon} size={16} />
      <span className="label">{label}</span>
      {count !== undefined && count !== null ? (
        <span className={`count ${alert ? 'alert' : ''}`}>{count > 99 ? '99+' : count}</span>
      ) : null}
    </NavLink>
  );
}

export function Sidebar({ pendingApprovals = 0, openCount = 0, rail, onNavigate }) {
  const [approver] = useApprover();
  const who = approver || 'No name set';
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">
          <Icon name="sparkles" size={16} strokeWidth={2.2} />
        </span>
        <span className="sidebar-wordmark">
          <strong>Cost Janitor</strong>
          <span>FinOps</span>
        </span>
      </div>

      <nav className="sidebar-nav">
        <div className="sidebar-section-label">Overview</div>
        <NavItem to="/" label="Dashboard" icon="dashboard" end onNavigate={onNavigate} />
        <NavItem
          to="/insights"
          label="Insights"
          icon="gauge"
          count={openCount || undefined}
          onNavigate={onNavigate}
        />

        <div className="sidebar-section-label">Workflow</div>
        <NavItem
          to="/approvals"
          label="Approvals"
          icon="inbox"
          count={pendingApprovals || undefined}
          alert={pendingApprovals > 0}
          onNavigate={onNavigate}
        />
        <NavItem to="/findings" label="Findings" icon="list" onNavigate={onNavigate} />

        <div className="sidebar-section-label">Reference</div>
        <NavItem to="/docs" label="How it works" icon="book" onNavigate={onNavigate} />
        <NavItem to="/settings" label="Settings" icon="settings" onNavigate={onNavigate} />
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user" title={`Approving as ${who}`}>
          <span className="avatar">{approver ? initials(approver) : '?'}</span>
          <span className="sidebar-user-meta">
            <strong>{who}</strong>
            <span>Approver</span>
          </span>
        </div>
      </div>
    </aside>
  );
}

/* ==========================================================================
   Topbar
   ========================================================================== */

const CRUMBS = {
  '/': { crumb: 'Overview', title: 'Dashboard' },
  '/insights': { crumb: 'Overview', title: 'Insights' },
  '/approvals': { crumb: 'Workflow', title: 'Approvals' },
  '/findings': { crumb: 'Workflow', title: 'Findings' },
  '/docs': { crumb: 'Reference', title: 'How it works' },
  '/settings': { crumb: 'Reference', title: 'Settings' },
};

export function Topbar({ onMenu, pendingApprovals, onNavigate, config }) {
  const { pathname } = useLocation();
  const { theme, mode, setTheme, toggle } = useTheme();
  const meta = CRUMBS[pathname] || { crumb: 'Cloud Cost Janitor', title: 'Not found' };

  useEffect(() => {
    const titles = Object.values(CRUMBS).map((c) => c.title);
    document.title = titles.includes(meta.title) ? `${meta.title} · Cloud Cost Janitor` : 'Cloud Cost Janitor';
  }, [meta.title]);

  return (
    <header className="topbar">
      <button className="btn btn-ghost btn-icon btn-md mobile-only" onClick={onMenu} aria-label="Open navigation">
        <Icon name="menu" size={18} />
      </button>

      <div className="topbar-trail">
        <span className="crumb-hide t-sm">{meta.crumb}</span>
        <span className="sep crumb-hide">/</span>
        <span className="current">{meta.title}</span>
      </div>

      <div className="topbar-actions">
        <DemoModeChip config={config} />
        <span className="crumb-hide">
          <ApproverField />
        </span>
        <NavLink
          to="/approvals"
          onClick={onNavigate}
          className="btn btn-ghost btn-icon btn-md"
          style={{ position: 'relative' }}
          aria-label={`${pendingApprovals} pending approvals`}
          title="Pending approvals"
        >
          <Icon name="bell" size={17} />
          {pendingApprovals > 0 ? (
            <span
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                minWidth: 15,
                height: 15,
                padding: '0 3px',
                borderRadius: 999,
                background: 'var(--warn)',
                color: 'var(--text-inverse)',
                fontSize: 9,
                fontWeight: 700,
                display: 'grid',
                placeItems: 'center',
                lineHeight: 1,
              }}
            >
              {pendingApprovals > 9 ? '9+' : pendingApprovals}
            </span>
          ) : null}
        </NavLink>

        <div className="divider-v" style={{ height: 22, alignSelf: 'center' }} />

        <Button
          variant="ghost"
          size="md"
          iconOnly
          icon={theme === 'dark' ? 'sun' : 'moon'}
          onClick={toggle}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`${theme === 'dark' ? 'Light' : 'Dark'} theme (currently ${mode})`}
        />
      </div>
    </header>
  );
}

/* ==========================================================================
   Page header
   ========================================================================== */

export function PageHeader({ eyebrow, title, subtitle, actions, children }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        {eyebrow ? <div className="page-eyebrow">{eyebrow}</div> : null}
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
        {children}
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </div>
  );
}

export function SectionHeader({ title, description, action, icon }) {
  return (
    <div className="section-head">
      <h2 className="section-title">
        {icon ? <Icon name={icon} size={16} className="t-muted" /> : null}
        {title}
      </h2>
      {action || (description && <span className="section-desc">{description}</span>)}
    </div>
  );
}

/* ==========================================================================
   Footer
   ========================================================================== */

export function AppFooter({ fetchedAt }) {
  return (
    <footer className="app-footer">
      <span>Cloud Cost Janitor v1.0.0</span>
      <span className="row row-5">
        {fetchedAt ? <span>Data as of {relativeTime(fetchedAt)}</span> : null}
        <span className="dot-sep">·</span>
        <span>us-east-1</span>
      </span>
    </footer>
  );
}

/* ==========================================================================
   Error boundary
   ========================================================================== */

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Unhandled UI error:', error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="container" style={{ padding: 'var(--s-12) var(--s-9)' }}>
        <div className="card" style={{ maxWidth: 560, margin: '0 auto' }}>
          <div className="card-body stack stack-6">
            <div className="stat-icon sev-critical" style={{ width: 40, height: 40 }}>
              <Icon name="alertTriangle" size={20} />
            </div>
            <div>
              <h3 style={{ marginBottom: 6 }}>Something broke while rendering this page</h3>
              <p className="t-sm t-dim">{error.message || String(error)}</p>
            </div>
            <div className="row row-5">
              <Button variant="primary" icon="refresh" onClick={() => this.setState({ error: null })}>
                Try again
              </Button>
              <Button variant="secondary" icon="externalLink" onClick={() => window.location.assign('/')}>
                Back to dashboard
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

/* ==========================================================================
   Drawer wrapper for small screens
   ========================================================================== */

export function useDrawer() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return [open, setOpen];
}
