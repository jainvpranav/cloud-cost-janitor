/** Presentation-layer formatters. Pure functions, no React. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** $0 / $12.40 / $1.2k / $18.4k / $1.24M */
export function money(value, { compact = false, decimals } = {}) {
  const n = Number(value);
  if (!isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (compact && abs >= 1_000_000) return `${n < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(2)}M`;
  if (compact && abs >= 10_000) return `${n < 0 ? '-' : ''}$${(abs / 1000).toFixed(1)}k`;
  if (compact && abs >= 1000) return `${n < 0 ? '-' : ''}$${(abs / 1000).toFixed(2)}k`;
  const d = decimals ?? (abs > 0 && abs < 1 ? 2 : abs >= 1000 ? 0 : 2);
  return `${n < 0 ? '-' : ''}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`;
}

/** Splits a money value so the unit can be rendered smaller. */
export function moneyParts(value, { compact = true } = {}) {
  const s = money(value, { compact });
  const i = s.replace(/^[-]/, '').search(/[.kM]?$/);
  const lead = s.startsWith('-') ? '-' : '';
  const body = s.replace(/^[-]/, '');
  const cut = body.search(/\d/);
  return {
    currency: lead + body.slice(0, cut),
    number: body.slice(cut),
    full: s,
  };
}

export function num(value, { compact = false, decimals = 0 } = {}) {
  const n = Number(value);
  if (!isFinite(n)) return '—';
  if (compact && Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (compact && Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function percent(value, { decimals = 0, of = 1 } = {}) {
  const n = Number(value);
  if (!isFinite(n)) return '—';
  return `${((n / of) * 100).toFixed(decimals)}%`;
}

/** Format a 0–1 ratio as a percentage: pct(0.9) === "90%". */
export function pct(value, decimals = 0) {
  return percent(value, { decimals, of: 1 });
}

export function bytes(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / Math.pow(1024, i);
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function duration(hours) {
  const h = Number(hours);
  if (!isFinite(h) || h < 0) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 45) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

export function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

export function relativeTime(value) {
  const d = parseDate(value);
  if (!d) return '—';
  const diff = Date.now() - d.getTime();
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  const fmt = (n, unit) => `${n}${unit}${future ? ' from now' : ' ago'}`;
  if (s < 45) return future ? 'in a moment' : 'just now';
  if (s < 3600) return fmt(Math.round(s / 60), 'm');
  if (s < 86400) return fmt(Math.round(s / 3600), 'h');
  if (s < 2592000) return fmt(Math.round(s / 86400), 'd');
  if (s < 31536000) return fmt(Math.round(s / 2592000), 'mo');
  return fmt((s / 31536000).toFixed(1), 'y');
}

export function shortDate(value) {
  const d = parseDate(value);
  if (!d) return '—';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function dateTime(value) {
  const d = parseDate(value);
  if (!d) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${hh}:${mm}`;
}

export function ageInDays(value) {
  const d = parseDate(value);
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

export function hoursSince(value) {
  const d = parseDate(value);
  if (!d) return null;
  return (Date.now() - d.getTime()) / 3600000;
}

export function titleCase(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .split(/[\s_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** EC2 → ec2, PENDING_APPROVAL → pending approval */
export function humanize(s) {
  if (!s) return '';
  if (/^[A-Z0-9_]+$/.test(s)) return titleCase(s);
  return titleCase(String(s).replace(/[_-]+/g, ' '));
}

export function initials(name) {
  if (!name) return '?';
  return String(name)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

export function truncate(s, n = 80) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function sum(arr, pick = (x) => x) {
  return arr.reduce((a, b) => a + (Number(pick(b)) || 0), 0);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
