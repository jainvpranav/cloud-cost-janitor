import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icons';
import { money, num } from '../lib/format';
import { costTone } from '../lib/metrics';

/* ==========================================================================
   Buttons
   ========================================================================== */

const BUTTON_VARIANTS = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  soft: 'btn-soft',
  success: 'btn-success',
  'success-soft': 'btn-success-soft',
  danger: 'btn-danger',
  'danger-soft': 'btn-danger-soft',
  'warn-soft': 'btn-warn-soft',
};

const BUTTON_SIZES = { xs: 'btn-xs', sm: 'btn-sm', md: 'btn-md', lg: 'btn-lg' };

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  disabled,
  block,
  iconOnly,
  className = '',
  type = 'button',
  ...rest
}) {
  const classes = [
    'btn',
    BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.secondary,
    BUTTON_SIZES[size] || BUTTON_SIZES.md,
    iconOnly ? 'btn-icon' : '',
    block ? 'btn-block' : '',
    loading ? 'loading' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} type={type} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'xs' ? 12 : 14} /> : null}
      {!iconOnly && children ? <span className="btn-label">{children}</span> : null}
      {iconRight && !loading ? <Icon name={iconRight} size={size === 'xs' ? 12 : 14} /> : null}
    </button>
  );
}

export function IconButton({ icon, label, size = 'md', variant = 'ghost', ...rest }) {
  return <Button icon={icon} iconOnly size={size} variant={variant} aria-label={label} title={label} {...rest} />;
}

/* ==========================================================================
   Surfaces
   ========================================================================== */

export function Card({ children, className = '', hoverable, pad, accent, ...rest }) {
  return (
    <div
      className={['card', hoverable ? 'hoverable' : '', pad ? 'pad' : '', accent ? 'accent' : '', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, icon, action, children, plain, className = '' }) {
  return (
    <div className={['card-header', plain ? 'plain' : '', className].filter(Boolean).join(' ')}>
      <div className="card-header-title">
        {icon ? <Icon name={icon} size={16} className="t-muted" /> : null}
        <div className="grow">
          {title ? <h3>{title}</h3> : null}
          {subtitle ? <div className="sub">{subtitle}</div> : null}
          {children}
        </div>
      </div>
      {action ? <div className="row row-5">{action}</div> : null}
    </div>
  );
}

export function CardBody({ children, tight, flush, className = '' }) {
  return <div className={['card-body', tight ? 'tight' : '', flush ? 'flush' : '', className].filter(Boolean).join(' ')}>{children}</div>;
}

export function CardFooter({ children, className = '' }) {
  return <div className={`card-footer ${className}`}>{children}</div>;
}

export function Panel({ children, className = '', ...rest }) {
  return (
    <div className={`panel ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function Divider({ vertical, className = '' }) {
  return vertical ? <div className={`divider-v ${className}`} /> : <div className={`divider ${className}`} />;
}

/* ==========================================================================
   Badges & chips
   ========================================================================== */

export function Badge({ children, tone = 'neutral', dot, size, mono, className = '', title }) {
  return (
    <span
      className={['badge', `tone-${tone}`, size === 'lg' ? 'badge-lg' : '', mono ? 'badge-mono' : '', className]
        .filter(Boolean)
        .join(' ')}
      title={title}
    >
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

export function Chip({ k, v, children, className = '' }) {
  return (
    <span className={`chip ${className}`} title={typeof children === 'string' ? children : undefined}>
      {k ? <span className="k">{k}</span> : null}
      {children ? <span className="v">{children}</span> : v !== undefined ? <span className="v">{v}</span> : null}
    </span>
  );
}

/** Status badge driven by the shared STATUS_META map. */
export function StatusBadge({ status, size, dot = true }) {
  const meta = {
    PENDING_ENRICHMENT: { tone: 'ai', label: 'Enriching' },
    PENDING_APPROVAL: { tone: 'warn', label: 'Awaiting review' },
    APPROVED: { tone: 'brand', label: 'Approved' },
    REJECTED: { tone: 'danger', label: 'Rejected' },
    TEARDOWN_COMPLETE: { tone: 'success', label: 'Reclaimed' },
    EXPIRED: { tone: 'neutral', label: 'Expired' },
  }[status] || { tone: 'neutral', label: status || 'Unknown' };
  return (
    <Badge tone={meta.tone} dot={dot} size={size}>
      {meta.label}
    </Badge>
  );
}

const REC_TONE = { delete: 'danger', keep: 'success', investigate: 'warn', review: 'warn' };

export function RecommendationBadge({ recommendation, confidence, size }) {
  if (!recommendation) return null;
  return (
    <Badge tone={REC_TONE[recommendation] || 'neutral'} size={size}>
      {recommendation}
      {confidence !== undefined && confidence !== null
        ? ` · ${Math.round((confidence > 1 ? confidence / 100 : confidence) * 100)}%`
        : ''}
    </Badge>
  );
}

const RISK_TONE = { low: 'success', medium: 'warn', high: 'danger' };

export function RiskBadge({ risk, size }) {
  if (!risk) return null;
  return (
    <Badge tone={RISK_TONE[risk] || 'neutral'} size={size}>
      {risk} risk
    </Badge>
  );
}

export function ResourceTypeBadge({ type, size }) {
  return (
    <Badge tone="neutral" mono size={size}>
      {type}
    </Badge>
  );
}

/* ==========================================================================
   Money
   ========================================================================== */

export function Money({ amount, tone, size, compact = false, className = '', signed = false, decimals }) {
  const t = tone || costTone(amount);
  const cls = ['money', t === 'danger' ? 'money-neg' : t === 'warn' ? 'money-warn' : t === 'success' ? 'money-pos' : 'money-muted', size === 'lg' ? 'money-lg' : '', className]
    .filter(Boolean)
    .join(' ');
  const prefix = signed && (Number(amount) || 0) > 0 ? '+' : '';
  return <span className={cls}>{prefix}{money(amount, { compact, decimals })}</span>;
}

/** Back-compat alias used by older call sites. */
export const Cost = ({ amount, className = '' }) => <Money amount={amount} className={className} />;

export function Delta({ value, suffix = '%', invert = false, showIcon = true, className = '' }) {
  const v = Number(value);
  const dir = !isFinite(v) || Math.abs(v) < 0.05 ? 'flat' : v > 0 ? 'up' : 'down';
  const good = invert ? dir === 'down' : dir === 'up';
  const cls = dir === 'flat' ? 'flat' : good ? 'up' : 'down';
  const icon = dir === 'up' ? 'trendingUp' : dir === 'down' ? 'trendingDown' : 'minus';
  return (
    <span className={`stat-delta ${cls} ${className}`}>
      {showIcon && dir !== 'flat' ? <Icon name={icon} size={12} /> : null}
      {isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}${suffix}` : '—'}
    </span>
  );
}

/* ==========================================================================
   Stat tiles
   ========================================================================== */

const STAT_TONES = {
  success: { accent: 'var(--success)', bg: 'var(--success-subtle)', fg: 'var(--success-fg)' },
  brand: { accent: 'var(--brand)', bg: 'var(--brand-subtle)', fg: 'var(--brand-fg)' },
  warn: { accent: 'var(--warn)', bg: 'var(--warn-subtle)', fg: 'var(--warn-fg)' },
  danger: { accent: 'var(--danger)', bg: 'var(--danger-subtle)', fg: 'var(--danger-fg)' },
  info: { accent: 'var(--info)', bg: 'var(--info-subtle)', fg: 'var(--info-fg)' },
  ai: { accent: 'var(--ai)', bg: 'var(--ai-subtle)', fg: 'var(--ai-fg)' },
  neutral: { accent: 'var(--border-strong)', bg: 'var(--surface-inset)', fg: 'var(--text-3)' },
};

export function StatTile({
  label,
  value,
  unit,
  icon,
  tone = 'neutral',
  hint,
  delta,
  deltaSuffix,
  invertDelta,
  footer,
  children,
  hoverable,
  onClick,
  className = '',
}) {
  const t = STAT_TONES[tone] || STAT_TONES.neutral;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={['stat', hoverable ? 'hoverable' : '', className].filter(Boolean).join(' ')}
      style={{ '--stat-accent': t.accent, '--stat-icon-bg': t.bg, '--stat-icon-fg': t.fg, textAlign: 'left' }}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
    >
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon ? (
          <span className="stat-icon">
            <Icon name={icon} size={15} />
          </span>
        ) : null}
      </div>
      <div className="stat-value">
        {value}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {children}
      <div className="stat-foot">
        {delta !== undefined && delta !== null ? (
          <Delta value={delta} suffix={deltaSuffix} invert={invertDelta} />
        ) : null}
        {hint ? <span className="t-truncate">{hint}</span> : null}
        {footer}
      </div>
    </Tag>
  );
}

export function Metric({ label, value, hint, tone, className = '' }) {
  return (
    <div className={`metric ${className}`}>
      <span className="metric-label">{label}</span>
      <span className={`metric-value ${tone ? `t-${tone}` : ''}`}>{value}</span>
      {hint ? <span className="metric-hint">{hint}</span> : null}
    </div>
  );
}

/* ==========================================================================
   Progress
   ========================================================================== */

export function Meter({ value, max = 100, tone = 'brand', size, className = '', style }) {
  const pctv = max > 0 ? Math.max(0, Math.min(100, (Number(value) / max) * 100)) : 0;
  const colors = {
    brand: 'var(--brand)',
    success: 'var(--success)',
    warn: 'var(--warn)',
    danger: 'var(--danger)',
    info: 'var(--info)',
    ai: 'var(--ai)',
  };
  return (
    <div
      className={['meter', size ? `meter-${size}` : '', className].filter(Boolean).join(' ')}
      role="progressbar"
      aria-valuenow={Math.round(pctv)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={style}
    >
      <div className="meter-bar" style={{ width: `${pctv}%`, background: colors[tone] || colors.brand }} />
    </div>
  );
}

export function MeterRow({ label, value, max, display, tone = 'brand', icon, size }) {
  return (
    <div className="meter-row">
      <div className="meter-row-head">
        <span className="k">
          {icon ? <Icon name={icon} size={13} /> : null}
          {label}
        </span>
        <span className="v">{display}</span>
      </div>
      <Meter value={value} max={max} tone={tone} size={size} />
    </div>
  );
}

/** Approval vote tally: shows the ratio at a glance, not just "2 / 3". */
export function VoteMeter({ approved, rejected, required }) {
  const total = Math.max(required, approved + rejected, 1);
  return (
    <div className="vote-track">
      <div className="meter">
        <div
          className="meter-bar"
          style={{ width: `${(approved / total) * 100}%`, background: 'var(--success)' }}
        />
        <div
          className="meter-bar"
          style={{ width: `${(rejected / total) * 100}%`, background: 'var(--danger)' }}
        />
      </div>
      <div className="vote-legend">
        <span className="k">
          <span className="swatch" style={{ background: 'var(--success)' }} />
          {approved} approve
        </span>
        <span className="k">
          <span className="swatch" style={{ background: 'var(--danger)' }} />
          {rejected} reject
        </span>
      </div>
    </div>
  );
}

export function ConfidenceMeter({ value }) {
  const v = value === null || value === undefined ? null : Number(value) > 1 ? Number(value) / 100 : Number(value);
  const tone = v === null ? 'neutral' : v >= 0.8 ? 'success' : v >= 0.6 ? 'info' : v >= 0.4 ? 'warn' : 'danger';
  return (
    <div className="confidence-meter">
      <Meter value={v || 0} tone={tone} size="sm" />
      <span className="val">{v === null ? '—' : `${Math.round(v * 100)}%`}</span>
    </div>
  );
}

/* ==========================================================================
   Form controls
   ========================================================================== */

export function Field({ label, hint, error, required, optional, children, className = '' }) {
  return (
    <div className={`form-group ${className}`}>
      {label ? (
        <label>
          {label}
          {required ? <span className="req">*</span> : null}
          {optional ? <span className="opt">optional</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <span className="field-error">
          <Icon name="alertCircle" size={12} />
          {error}
        </span>
      ) : hint ? (
        <span className="field-help">{hint}</span>
      ) : null}
    </div>
  );
}

export function Input({ label, error, hint, required, optional, prefix, suffix, className = '', ...props }) {
  const input = (
    <input
      className={`${error ? 'invalid' : ''} ${className}`}
      aria-invalid={error ? 'true' : undefined}
      {...props}
    />
  );
  return (
    <Field label={label} hint={hint} error={error} required={required} optional={optional}>
      {prefix || suffix ? (
        <div className="input-prefix">
          {prefix ? <Icon name={prefix} size={15} /> : null}
          {input}
          {suffix ? <span className="input-suffix">{suffix}</span> : null}
        </div>
      ) : (
        input
      )}
    </Field>
  );
}

export function Textarea({ label, error, hint, required, optional, className = '', ...props }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} optional={optional}>
      <textarea className={error ? 'invalid' : className} aria-invalid={error ? 'true' : undefined} {...props} />
    </Field>
  );
}

export function Select({ label, options = [], error, hint, required, optional, className = '', ...props }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} optional={optional}>
      <select className={error ? 'invalid' : className} {...props}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Switch({ checked, onChange, label, disabled, id }) {
  return (
    <label className="switch" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" />
      {label ? <span className="switch-label">{label}</span> : null}
    </label>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className = '', ...rest }) {
  return (
    <div className={`input-prefix ${className}`}>
      <Icon name="search" size={14} />
      <input type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} {...rest} />
    </div>
  );
}

/* ==========================================================================
   Navigation
   ========================================================================== */

export function Tabs({ tabs, activeTab, onChange, className = '' }) {
  return (
    <div className={`tabs ${className}`} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={activeTab === t.id}
          className={`tab ${activeTab === t.id ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined ? <span className="n">{num(t.count)}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Segmented({ options, value, onChange, className = '' }) {
  return (
    <div className={`segmented ${className}`} role="group">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
        >
          {o.icon ? <Icon name={o.icon} size={13} /> : null}
          {o.label}
          {o.count !== undefined ? <span className="n">{num(o.count)}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ==========================================================================
   Feedback
   ========================================================================== */

const ALERT_ICONS = { info: 'info', success: 'checkCircle', warning: 'alertTriangle', error: 'alertCircle', ai: 'sparkles', neutral: 'info' };

export function Alert({ children, variant = 'info', title, icon, onDismiss, style, className = '', iconOnly }) {
  const ic = iconOnly ? null : icon || ALERT_ICONS[variant] || 'info';
  return (
    <div className={['alert', `alert-${variant}`, className].filter(Boolean).join(' ')} style={style} role={variant === 'error' ? 'alert' : 'status'}>
      {ic ? <Icon name={ic} size={16} /> : null}
      <div className="alert-body">
        {title ? <div className="alert-title">{title}</div> : null}
        {children}
      </div>
      {onDismiss ? (
        <button className="alert-close" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ icon = 'inbox', title, description, children, compact }) {
  return (
    <div className="empty-state" style={compact ? { padding: 'var(--s-9) var(--s-7)' } : undefined}>
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      {title ? <h3>{title}</h3> : null}
      {description ? <p>{description}</p> : null}
      {children ? <div className="row row-5 row-wrap">{children}</div> : null}
    </div>
  );
}

export function Skeleton({ w, h = 11, circle, className = '', style }) {
  return (
    <div
      className={['skeleton', circle ? 'skeleton-circle' : '', className].filter(Boolean).join(' ')}
      style={{ width: w, height: h, ...style }}
    />
  );
}

export function SkeletonText({ lines = 3, width = '100%' }) {
  return (
    <div className="stack stack-2">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} w={i === lines - 1 ? '62%' : width} h={10} />
      ))}
    </div>
  );
}

export function SkeletonStats({ count = 4 }) {
  return (
    <div className="stat-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div className="stat" key={i}>
          <div className="stat-top">
            <Skeleton w={110} h={11} />
            <Skeleton w={30} h={30} circle />
          </div>
          <Skeleton w="62%" h={26} />
          <Skeleton w="42%" h={10} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 5, cols = 5 }) {
  return (
    <div className="stack">
      {Array.from({ length: rows }).map((_, r) => (
        <div className="row row-7" key={r} style={{ padding: 'var(--s-6) var(--s-7)' }}>
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} w={c === 0 ? '32%' : '14%'} h={11} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading…' }) {
  return (
    <div className="loading-block">
      <div className="spinner-page" />
      <span>{label}</span>
    </div>
  );
}

/* ==========================================================================
   Tables
   ========================================================================== */

export function Table({ children, className = '' }) {
  return (
    <div className="table-wrap">
      <table className={`table ${className}`}>{children}</table>
    </div>
  );
}

export const TableHead = ({ children }) => <thead>{children}</thead>;
export const TableBody = ({ children }) => <tbody>{children}</tbody>;
export const TableRow = ({ children, ...rest }) => <tr {...rest}>{children}</tr>;

export function TableCell({ children, align, tight, strong, className = '', ...rest }) {
  return (
    <td
      className={[align ? align : '', tight ? 'col-tight' : '', strong ? 'strong' : '', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </td>
  );
}

export function TableHeaderCell({ children, align, sortable, sorted, onSort, className = '', ...rest }) {
  return (
    <th
      className={[align === 'right' ? 'right' : align === 'center' ? 'center' : '', sortable ? 'sortable' : '', className]
        .filter(Boolean)
        .join(' ')}
      onClick={sortable ? onSort : undefined}
      aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
      {...rest}
    >
      <span className="th-inner">
        {children}
        {sortable ? <Icon name={sorted === 'asc' ? 'chevronUp' : sorted === 'desc' ? 'chevronDown' : 'chevronDown'} size={12} style={{ opacity: sorted ? 1 : 0.3 }} /> : null}
      </span>
    </th>
  );
}

/* ==========================================================================
   Modal
   ========================================================================== */

export function Modal({ isOpen, onClose, title, subtitle, children, footer, size }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-overlay" onMouseDown={onClose} role="presentation">
      <div
        className={`modal ${size === 'lg' ? 'modal-lg' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div className="modal-header">
          <div className="grow">
            <h3>{title}</h3>
            {subtitle ? <div className="sub">{subtitle}</div> : null}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close dialog">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog({ isOpen, onCancel, onConfirm, title, message, confirmLabel = 'Confirm', tone = 'primary', loading }) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 'var(--fs-md)', lineHeight: 'var(--lh-loose)' }}>{message}</p>
    </Modal>
  );
}

/* ==========================================================================
   Misc
   ========================================================================== */

export function KeyValue({ items, cols = 2 }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map(([k, v]) => (
        <div key={k} className="stack stack-2">
          <span className="metric-label">{k}</span>
          <span className="t-md t-medium">{v ?? '—'}</span>
        </div>
      ))}
    </div>
  );
}
