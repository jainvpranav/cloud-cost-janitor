import React, { useId, useState } from 'react';

import { money, num, pct } from '../lib/format';

/* ==========================================================================
   Sparkline — compact trend for stat tiles
   ========================================================================== */

export function Sparkline({
  data = [],
  width = 160,
  height = 34,
  stroke = 'var(--brand)',
  fill = true,
  showArea = true,
}) {
  const gid = useId().replace(/:/g, '');
  const pts = data.map((d) => (typeof d === 'number' ? d : d.count ?? d.value ?? 0));
  if (pts.length < 2) return <div style={{ height }} aria-hidden="true" />;

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const pad = 3;
  const stepX = (width - pad * 2) / (pts.length - 1);
  const y = (v) => height - pad - ((v - min) / range) * (height - pad * 2);
  const coords = pts.map((v, i) => [pad + i * stepX, y(v)]);
  const line = coords.map(([x, yy], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${yy.toFixed(2)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1][0].toFixed(2)},${height} L${coords[0][0].toFixed(2)},${height} Z`;
  const last = coords[coords.length - 1];

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height }}
      aria-hidden="true"
    >
      {showArea ? (
        <>
          <defs>
            <linearGradient id={`sp-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.24" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#sp-${gid})`} />
        </>
      ) : null}
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.2" fill={stroke} />
    </svg>
  );
}

/* ==========================================================================
   Horizontal bar chart — the right default for named categories
   ========================================================================== */

export function BarChart({
  data = [],
  valueFormat = (v) => money(v, { compact: true }),
  max: maxOverride,
  showValues = true,
  barHeight = 22,
  gap = 12,
  colors,
  onSelect,
}) {
  const max = maxOverride ?? Math.max(...data.map((d) => d.value), 0);
  if (!data.length) return null;

  return (
    <div className="stack stack-5">
      {data.map((d, i) => {
        const pctw = max > 0 ? (d.value / max) * 100 : 0;
        const color = d.color || (colors ? colors[i % colors.length] : 'var(--viz-1)');
        return (
          <div
            className="meter-row"
            key={d.key || d.label}
            onClick={onSelect ? () => onSelect(d) : undefined}
            style={onSelect ? { cursor: 'pointer' } : undefined}
          >
            <div className="meter-row-head">
              <span className="k t-truncate">
                {d.icon ? <IconDot color={color} /> : null}
                <span className="t-truncate">{d.label}</span>
              </span>
              {showValues ? <span className="v">{valueFormat(d.value, d)}</span> : null}
            </div>
            <div className="meter" style={{ height: barHeight, borderRadius: 6 }}>
              <div
                className="meter-bar"
                style={{ width: `${Math.max(pctw, d.value > 0 ? 1.5 : 0)}%`, background: color, borderRadius: 6 }}
              />
            </div>
            {d.sub ? <span className="t-xs t-muted">{d.sub}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function IconDot({ color }) {
  return <span className="legend-item" style={{ padding: 0 }}><span className="swatch" style={{ background: color }} /></span>;
}

/* ==========================================================================
   Donut chart
   ========================================================================== */

export function DonutChart({
  data = [],
  size = 168,
  thickness = 22,
  centerValue,
  centerLabel,
  valueFormat = (v) => num(v),
}) {
  const [hover, setHover] = useState(null);
  const total = data.reduce((a, b) => a + (Number(b.value) || 0), 0);
  if (total <= 0) {
    return (
      <div className="row" style={{ justifyContent: 'center' }}>
        <div className="donut-center" style={{ width: size, height: size }}>
          <span className="big t-muted">—</span>
          <span className="lbl">no data</span>
        </div>
      </div>
    );
  }

  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="row row-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={thickness} />
          {data.map((d, i) => {
            const frac = (Number(d.value) || 0) / total;
            const len = frac * c;
            const el = (
              <circle
                key={d.key || d.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={d.color || `var(--viz-${(i % 8) + 1})`}
                strokeWidth={hover === i ? thickness + 4 : thickness}
                strokeDasharray={`${Math.max(len - 2, 0)} ${c}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
                style={{ transition: 'stroke-width 140ms ease', cursor: 'pointer' }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            );
            offset += len;
            return el;
          })}
        </svg>
        <div
          className="donut-center"
          style={{ position: 'absolute', inset: 0 }}
        >
          <span className="big">
            {hover !== null ? valueFormat(data[hover].value) : centerValue}
          </span>
          <span className="lbl">{hover !== null ? data[hover].label : centerLabel}</span>
        </div>
      </div>

      <div className="stack stack-4 grow" style={{ minWidth: 160 }}>
        {data.map((d, i) => (
          <div
            className="legend-item"
            key={d.key || d.label}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            style={{ opacity: hover === null || hover === i ? 1 : 0.55, cursor: 'default' }}
          >
            <span className="swatch" style={{ background: d.color || `var(--viz-${(i % 8) + 1})` }} />
            <span className="t-truncate grow">{d.label}</span>
            <span className="lv">{valueFormat(d.value)}</span>
            <span className="t-xs t-muted tnum" style={{ width: 34, textAlign: 'right' }}>
              {pct((d.value / total) * 100, 0)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ==========================================================================
   Pipeline funnel — where findings are sitting right now
   ========================================================================== */

export function Funnel({ stages = [], onSelect }) {
  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <div className="stack stack-5">
      {stages.map((s) => {
        const w = (s.value / max) * 100;
        return (
          <button
            key={s.key}
            className="meter-row"
            onClick={onSelect ? () => onSelect(s) : undefined}
            style={{
              background: 'none',
              textAlign: 'left',
              cursor: onSelect ? 'pointer' : 'default',
              padding: 'var(--s-2) 0',
            }}
          >
            <div className="meter-row-head">
              <span className="k">
                <span className="legend-item" style={{ padding: 0 }}>
                  <span className="swatch" style={{ background: s.color }} />
                </span>
                {s.label}
              </span>
              <span className="v">
                {num(s.value)}
                {s.money ? <span className="t-xs t-muted" style={{ marginLeft: 6, fontWeight: 400 }}>{money(s.money, { compact: true })}/mo</span> : null}
              </span>
            </div>
            <div className="meter meter-lg">
              <div
                className="meter-bar"
                style={{
                  width: `${Math.max(w, s.value > 0 ? 2 : 0)}%`,
                  background: s.color,
                  borderRadius: 6,
                }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   Stacked 100% bar — composition
   ========================================================================== */

export function StackedBar({ segments = [], height = 12, showLegend = true, valueFormat }) {
  const total = segments.reduce((a, b) => a + (Number(b.value) || 0), 0);
  const fmt = valueFormat || ((v) => num(v));
  if (total <= 0) return <div className="meter" style={{ height }} />;

  return (
    <div className="stack stack-5">
      <div className="meter" style={{ height, borderRadius: 6 }}>
        {segments.map((s, i) => (
          <div
            key={s.key || s.label}
            className="meter-bar"
            title={`${s.label}: ${fmt(s.value)}`}
            style={{
              width: `${((Number(s.value) || 0) / total) * 100}%`,
              background: s.color || `var(--viz-${(i % 8) + 1})`,
              borderRadius: 0,
            }}
          />
        ))}
      </div>
      {showLegend ? (
        <div className="legend">
          {segments.map((s, i) => (
            <span className="legend-item" key={s.key || s.label}>
              <span className="swatch" style={{ background: s.color || `var(--viz-${(i % 8) + 1})` }} />
              {s.label}
              <span className="lv">{fmt(s.value)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ==========================================================================
   Column chart — for time series with meaningful magnitudes
   ========================================================================== */

export function ColumnChart({ data = [], height = 150, valueFormat = (v) => num(v), color = 'var(--viz-1)' }) {
  const gid = useId().replace(/:/g, '');
  if (!data.length) return null;
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = data.length;
  const gapRatio = 0.28;
  const slot = 100 / n;
  const barW = slot * (1 - gapRatio);

  return (
    <div>
      <svg
        className="chart"
        viewBox={`0 0 100 ${height / 1.6}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height }}
        role="img"
        aria-label="Detections over time"
      >
        <defs>
          <linearGradient id={`col-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.95" />
            <stop offset="100%" stopColor={color} stopOpacity="0.45" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            className="grid-line"
            x1="0"
            x2="100"
            y1={(height / 1.6) * f}
            y2={(height / 1.6) * f}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {data.map((d, i) => {
          const h = (d.value / max) * (height / 1.6 - 4);
          return (
            <rect
              key={d.key || d.label || i}
              className="bar"
              x={i * slot + (slot - barW) / 2}
              y={(height / 1.6) - h}
              width={barW}
              height={Math.max(h, d.value > 0 ? 1 : 0)}
              rx="0.6"
              fill={`url(#col-${gid})`}
            >
              <title>{`${d.label}: ${valueFormat(d.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="row row-between t-xs t-muted" style={{ marginTop: 6 }}>
        <span>{data[0]?.label}</span>
        <span>{data[Math.floor(data.length / 2)]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}
