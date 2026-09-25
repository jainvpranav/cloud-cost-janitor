import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from './Icons';

/* ==========================================================================
   Code block with copy
   ========================================================================== */

export function CodeBlock({ code, lang = 'bash', title, copyable = true }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="row row-4">
          <Icon name="code" size={12} />
          {title || lang}
        </span>
        {copyable ? (
          <button className="code-copy row row-3" onClick={copy} aria-label="Copy to clipboard">
            <Icon name={copied ? 'check' : 'copy'} size={11} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : null}
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ==========================================================================
   Callout
   ========================================================================== */

export function Callout({ tone = 'info', icon, title, children }) {
  const ic = icon || (tone === 'warn' ? 'alertTriangle' : tone === 'danger' ? 'shield' : 'info');
  return (
    <div
      className="callout"
      style={
        tone === 'warn'
          ? { background: 'var(--warn-subtle)', borderColor: 'var(--warn-border)' }
          : tone === 'danger'
            ? { background: 'var(--danger-subtle)', borderColor: 'var(--danger-border)' }
            : tone === 'success'
              ? { background: 'var(--success-subtle)', borderColor: 'var(--success-border)' }
              : undefined
      }
    >
      <Icon name={ic} size={15} />
      <div>
        {title ? (
          <div className="t-semibold t-md" style={{ marginBottom: 2 }}>
            {title}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/* ==========================================================================
   Flow diagram — the pipeline
   ========================================================================== */

export function FlowDiagram({ nodes }) {
  return (
    <div className="flow" role="list">
      {nodes.map((n, i) => (
        <React.Fragment key={n.title}>
          <div className={`flow-node ${n.tone ? `tone-${n.tone}` : ''}`} role="listitem">
            <div className="row row-5">
              <span className="n-idx">{i + 1}</span>
              <span className="n-icon">
                <Icon name={n.icon} size={17} />
              </span>
            </div>
            <h4>{n.title}</h4>
            <p>{n.body}</p>
            {n.meta?.length ? (
              <div className="n-meta">
                {n.meta.map((m) => (
                  <span key={m}>{m}</span>
                ))}
              </div>
            ) : null}
          </div>
          {i < nodes.length - 1 ? (
            <div className="flow-arrow" aria-hidden="true">
              <Icon name="arrowRight" size={17} />
            </div>
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}

/* ==========================================================================
   Architecture layer stack
   ========================================================================== */

export function LayerStack({ layers }) {
  return (
    <div className="layers">
      {layers.map((l) => (
        <div className="layer" key={l.name}>
          <div className="layer-label">
            <span className="name">{l.name}</span>
            <span className="tier">{l.tier}</span>
          </div>
          <div className="layer-body">
            <p>{l.body}</p>
            {l.items?.length ? (
              <div className="row row-4 row-wrap">
                {l.items.map((it) => (
                  <span className="chip" key={it}>
                    {it}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   Stepper — ordered narrative
   ========================================================================== */

export function Stepper({ steps }) {
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <div className="step-item" key={s.title}>
          <div className={`step-marker ${s.tone ? `tone-${s.tone}` : ''}`}>{i + 1}</div>
          <div className="step-content">
            <h4>{s.title}</h4>
            {s.body ? <p>{s.body}</p> : null}
            {s.bullets?.length ? (
              <ul className="bullets" style={{ marginTop: 'var(--s-5)' }}>
                {s.bullets.map((b) => (
                  <li key={b} dangerouslySetInnerHTML={{ __html: inlineCode(b) }} />
                ))}
              </ul>
            ) : null}
            {s.meta?.length ? (
              <div className="step-meta">
                {s.meta.map((m) => (
                  <Badgeish key={m}>{m}</Badgeish>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function Badgeish({ children }) {
  return (
    <span className="chip">
      <span className="v">{children}</span>
    </span>
  );
}

/** Renders `backtick` spans as <code> so prose can reference identifiers. */
export function inlineCode(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
}

/* ==========================================================================
   Rule / reference table
   ========================================================================== */

export function RuleTable({ head, rows }) {
  return (
    <div className="table-wrap" style={{ margin: 'var(--s-7) 0', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)' }}>
      <table className="table rule-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j} className={j === 0 ? 'strong' : ''}>
                  <span dangerouslySetInnerHTML={{ __html: inlineCode(cell) }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ==========================================================================
   Stat strip for docs (facts, not KPIs)
   ========================================================================== */

export function FactStrip({ facts }) {
  return (
    <div className="stat-grid" style={{ margin: 'var(--s-7) 0' }}>
      {facts.map((f) => (
        <div className="stat" key={f.label} style={{ '--stat-accent': f.color || 'var(--brand)' }}>
          <div className="stat-top">
            <span className="stat-label">{f.label}</span>
            {f.icon ? (
              <span className="stat-icon">
                <Icon name={f.icon} size={15} />
              </span>
            ) : null}
          </div>
          <div className="stat-value">
            {f.value}
            {f.unit ? <span className="unit">{f.unit}</span> : null}
          </div>
          {f.hint ? <div className="stat-foot">{f.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   Section wrapper + table of contents
   ========================================================================== */

export function DocSection({ id, title, icon, children }) {
  return (
    <section className="docs-section" id={id}>
      <h2>
        {icon ? <Icon name={icon} size={17} className="t-muted" /> : null}
        {title}
        <a className="anchor" href={`#${id}`} aria-label={`Link to ${title}`}>
          #
        </a>
      </h2>
      {children}
    </section>
  );
}

/** Scroll-spy table of contents with client-side filtering. */
export function DocsToc({ sections }) {
  const [active, setActive] = useState(sections[0]?.id);
  const [query, setQuery] = useState('');

  useEffect(() => {
    // Scroll-spy is progressive enhancement. Where IntersectionObserver is
    // unavailable the TOC still works, it just doesn't highlight the section.
    if (typeof IntersectionObserver === 'undefined') return undefined;

    const targets = sections
      .map((s) => document.getElementById(s.id))
      .filter(Boolean);
    if (!targets.length) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-72px 0px -65% 0px', threshold: 0 }
    );
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [sections]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter(
      (s) => s.title.toLowerCase().includes(q) || (s.keywords || '').toLowerCase().includes(q)
    );
  }, [sections, query]);

  return (
    <nav className="docs-toc" aria-label="On this page">
      <div className="docs-toc-search input-prefix">
        <Icon name="search" size={13} />
        <input
          type="search"
          value={query}
          placeholder="Filter sections…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter documentation sections"
        />
      </div>
      <div className="t-upper t-muted" style={{ padding: '0 var(--s-5) var(--s-4)' }}>
        On this page
      </div>
      {filtered.length === 0 ? (
        <div className="t-xs t-muted" style={{ padding: 'var(--s-5)' }}>
          No sections match “{query}”.
        </div>
      ) : (
        filtered.map((s) => (
          <a key={s.id} href={`#${s.id}`} className={active === s.id ? 'active' : ''}>
            {s.title}
          </a>
        ))
      )}
    </nav>
  );
}
