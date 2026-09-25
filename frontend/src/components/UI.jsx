import React from 'react';

export const Badge = ({ children, variant = 'pending', className = '' }) => {
  const variants = {
    pending: 'badge-pending',
    approved: 'badge-approved',
    rejected: 'badge-rejected',
    complete: 'badge-complete',
    enrichment: 'badge-enrichment',
    low: 'badge-low',
    medium: 'badge-medium',
    high: 'badge-high',
  };
  return (
    <span className={`badge ${variants[variant]} ${className}`}>{children}</span>
  );
};

export const Cost = ({ amount, className = '' }) => {
  const costClass = amount > 100 ? 'cost-high' : amount > 30 ? 'cost-medium' : 'cost-low';
  return <span className={`cost ${costClass} ${className}`}>${amount.toFixed(2)}</span>;
};

export const Button = ({ children, variant = 'primary', size, disabled, onClick, className = '', ...props }) => {
  const variants = {
    primary: 'btn-primary',
    secondary: 'btn-secondary',
    danger: 'btn-danger',
    success: 'btn-success',
  };
  const sizes = { sm: 'btn-sm' };
  return (
    <button
      className={`${variants[variant]} ${sizes[size] || ''} ${className}`}
      disabled={disabled}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  );
};

export const Card = ({ children, className = '' }) => (
  <div className={`card ${className}`}>{children}</div>
);

export const CardHeader = ({ children, className = '' }) => (
  <div className={`card-header ${className}`}>{children}</div>
);

export const CardBody = ({ children, className = '' }) => (
  <div className={`card-body ${className}`}>{children}</div>
);

export const Table = ({ children, className = '' }) => (
  <div style={{ overflowX: 'auto' }}>
    <table className={`table ${className}`}>{children}</table>
  </div>
);

export const TableHead = ({ children }) => <thead>{children}</thead>;
export const TableBody = ({ children }) => <tbody>{children}</tbody>;
export const TableRow = ({ children, ...props }) => <tr {...props}>{children}</tr>;
export const TableCell = ({ children, ...props }) => <td {...props}>{children}</td>;
export const TableHeaderCell = ({ children, ...props }) => <th {...props}>{children}</th>;

export const Input = ({ label, error, help, ...props }) => (
  <div className="form-group">
    {label && <label>{label}</label>}
    <input {...props} />
    {error && <div style={{ color: 'var(--danger)', fontSize: '12px', marginTop: '4px' }}>{error}</div>}
    {help && <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>{help}</div>}
  </div>
);

export const Select = ({ label, options, ...props }) => (
  <div className="form-group">
    {label && <label>{label}</label>}
    <select {...props}>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  </div>
);

export const Alert = ({ children, variant = 'info', className = '' }) => (
  <div className={`alert alert-${variant} ${className}`}>{children}</div>
);

export const Modal = ({ isOpen, onClose, title, children, footer }) => {
  if (!isOpen) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '24px', cursor: 'pointer', color: 'var(--text-muted)' }}>&times;</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
};

export const NavLink = ({ children, to, active, onClick }) => (
  <a
    href={to}
    className={`nav-link ${active ? 'active' : ''}`}
    onClick={onClick}
  >
    {children}
  </a>
);

export const EmptyState = ({ icon = '📭', title = 'No data', description = '' }) => (
  <div className="empty-state">
    <div className="empty-state-icon">{icon}</div>
    <h3 style={{ margin: '0 0 8px', color: 'var(--text)' }}>{title}</h3>
    <p style={{ margin: 0 }}>{description}</p>
  </div>
);

export const Tabs = ({ tabs, activeTab, onChange }) => (
  <div className="tabs">
    {tabs.map((tab) => (
      <button
        key={tab.id}
        className={`tab ${activeTab === tab.id ? 'active' : ''}`}
        onClick={() => onChange(tab.id)}
      >
        {tab.label}
      </button>
    ))}
  </div>
);