import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icons';
import { PageHeader, SectionHeader } from '../components/Layout';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  LoadingBlock,
  Textarea,
} from '../components/UI';
import { configApi, toMessage } from '../api/client';
import { bytes, num } from '../lib/format';

const DEFAULT_CONFIG = {
  role_arn: '',
  account_id: '',
  cpu_threshold_percent: 5,
  cpu_hours: 24,
  network_idle_bytes: 1048576,
  ebs_unattached_days: 7,
  ebs_no_snapshot_days: 30,
  lb_idle_days: 7,
  excluded_tags: {
    Environment: ['prod', 'production'],
    CostJanitor: ['ignore', 'do-not-delete'],
  },
  notification_emails: ['admin@company.com'],
};

const RANGES = {
  cpu_threshold_percent: { min: 0, max: 100, suffix: '%', hint: 'A running instance averages below this CPU over the whole window.' },
  cpu_hours: { min: 1, max: 168, suffix: 'h', hint: 'Length of the CloudWatch lookback window. Longer is safer, slower.' },
  network_idle_bytes: { min: 0, hint: 'Total bytes received over the window. Both signals must be idle to flag an instance.' },
  ebs_unattached_days: { min: 1, max: 90, suffix: 'd', hint: 'Available volumes older than this are considered abandoned.' },
  ebs_no_snapshot_days: { min: 1, max: 365, suffix: 'd', hint: 'Volumes without a snapshot this recent are flagged — this is the real safety net.' },
  lb_idle_days: { min: 1, max: 90, suffix: 'd', hint: 'Load balancers with no healthy targets and no requests for this long.' },
};

function validate(config, tagsText, emailsText) {
  const errors = {};
  const check = (key, test) => {
    if (test) errors[key] = RANGES[key].hint;
  };
  check('cpu_threshold_percent', config.cpu_threshold_percent < 0 || config.cpu_threshold_percent > 100);
  check('cpu_hours', config.cpu_hours < 1 || config.cpu_hours > 168);
  check('network_idle_bytes', config.network_idle_bytes < 0);
  check('ebs_unattached_days', config.ebs_unattached_days < 1);
  check('ebs_no_snapshot_days', config.ebs_no_snapshot_days < 1);
  check('lb_idle_days', config.lb_idle_days < 1);

  if (config.account_id && !/^\d{12}$/.test(String(config.account_id).trim())) {
    errors.account_id = 'AWS account IDs are exactly 12 digits.';
  }
  if (config.role_arn && !String(config.role_arn).startsWith('arn:aws:iam::')) {
    errors.role_arn = 'Must be a full IAM role ARN.';
  }

  try {
    const parsed = JSON.parse(tagsText);
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      errors.excluded_tags = 'Must be a JSON object mapping tag keys to arrays of values.';
    } else {
      for (const [k, v] of Object.entries(parsed)) {
        if (!Array.isArray(v)) errors.excluded_tags = `Value for "${k}" must be an array.`;
      }
    }
  } catch (e) {
    errors.excluded_tags = `Invalid JSON: ${e.message}`;
  }

  const emails = emailsText.split(',').map((e) => e.trim()).filter(Boolean);
  const bad = emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (bad) errors.notification_emails = `"${bad}" is not a valid email address.`;

  return { errors, emails };
}

export const Settings = () => {
  const navigate = useNavigate();
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [tagsText, setTagsText] = useState(() => JSON.stringify(DEFAULT_CONFIG.excluded_tags, null, 2));
  const [emailsText, setEmailsText] = useState('admin@company.com');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [errors, setErrors] = useState({});
  const [dirty, setDirty] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const load = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await configApi.get();
      const merged = { ...DEFAULT_CONFIG, ...(res.data || {}) };
      setConfig(merged);
      setTagsText(JSON.stringify(merged.excluded_tags ?? {}, null, 2));
      setEmailsText((merged.notification_emails || []).join(', '));
      setDirty(false);
      setErrors({});
    } catch (e) {
      setMessage({ type: 'error', text: toMessage(e, 'Could not load configuration') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const set = (key, value) => {
    setConfig((c) => ({ ...c, [key]: value }));
    setDirty(true);
    setMessage(null);
  };

  const setNum = (key, raw) => {
    const n = Number(raw);
    set(key, Number.isFinite(n) ? n : 0);
  };

  const save = async () => {
    const { errors: errs, emails } = validate(config, tagsText, emailsText);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setMessage({ type: 'error', text: 'Fix the highlighted fields before saving.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        ...config,
        excluded_tags: JSON.parse(tagsText),
        notification_emails: emails,
      };
      await configApi.update(payload);
      setConfig(payload);
      setDirty(false);
      setMessage({ type: 'success', text: 'Configuration saved. The next scheduled scan will use these values.' });
    } catch (e) {
      setMessage({ type: 'error', text: toMessage(e, 'Failed to save configuration') });
    } finally {
      setSaving(false);
    }
  };

  const excludedSummary = useMemo(() => {
    try {
      const parsed = JSON.parse(tagsText);
      return Object.entries(parsed).map(([k, v]) => ({ key: k, values: Array.isArray(v) ? v : [] }));
    } catch {
      return [];
    }
  }, [tagsText]);

  if (loading) {
    return (
      <div className="app-body">
        <PageHeader title="Settings" subtitle="Loading configuration…" />
        <LoadingBlock label="Fetching scan configuration" />
      </div>
    );
  }

  return (
    <div className="app-body narrow">
      <PageHeader
        eyebrow={<><Icon name="settings" size={12} />Scan configuration</>}
        title="Settings"
        subtitle="These values drive the daily scan. Changes apply to the next run, not the current one."
        actions={
          <>
            <Button variant="ghost" icon="book" onClick={() => navigate('/docs')}>
              What do these do?
            </Button>
            <Button variant="secondary" icon="refresh" onClick={load} disabled={saving}>
              Reset
            </Button>
            <Button variant="primary" icon="check" onClick={save} loading={saving} disabled={!dirty && !message}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </>
        }
      />

      {message ? (
        <Alert variant={message.type === 'error' ? 'error' : 'success'} onDismiss={() => setMessage(null)}>
          {message.text}
        </Alert>
      ) : null}

      {dirty ? (
        <Alert variant="warning" title="Unsaved changes">
          These values are only in your browser until you save. The scanner keeps using the last persisted config.
        </Alert>
      ) : null}

      {/* ---------------- AWS target ---------------- */}
      <section className="section">
        <SectionHeader title="AWS target" icon="globe" description="Which account the scanner assumes a role in" />
        <Card>
          <CardBody>
            <div className="form-row">
              <Input
                label="Cross-account role ARN"
                placeholder="arn:aws:iam::123456789012:role/CostJanitorScanner"
                value={config.role_arn || ''}
                onChange={(e) => set('role_arn', e.target.value)}
                error={errors.role_arn}
                hint="The scanner calls sts:AssumeRole with this role. Leave blank to scan the same account."
                optional
              />
              <Input
                label="Account ID"
                placeholder="123456789012"
                value={config.account_id || ''}
                onChange={(e) => set('account_id', e.target.value)}
                error={errors.account_id}
                hint="Recorded on every finding for multi-account rollups."
                optional
              />
            </div>
          </CardBody>
        </Card>
      </section>

      {/* ---------------- Detection thresholds ---------------- */}
      <section className="section">
        <SectionHeader
          title="Detection thresholds"
          icon="sliders"
          description="Lower thresholds find more waste but increase false positives"
        />
        <Card>
          <CardHeader
            title="EC2 — idle compute"
            subtitle="Both the CPU and network signals must be below threshold to flag an instance"
          />
          <CardBody>
            <div className="grid grid-2">
              {['cpu_threshold_percent', 'cpu_hours', 'network_idle_bytes'].map((k) => (
                <Input
                  key={k}
                  type="number"
                  label={LABELS[k]}
                  min={RANGES[k].min}
                  max={RANGES[k].max}
                  suffix={RANGES[k].suffix}
                  value={config[k]}
                  onChange={(e) => setNum(k, e.target.value)}
                  error={errors[k]}
                  hint={RANGES[k].hint}
                />
              ))}
            </div>
            <div className="panel" style={{ marginTop: 'var(--s-7)' }}>
              <div className="row row-5" style={{ marginBottom: 6 }}>
                <Icon name="info" size={13} className="t-muted" />
                <span className="t-sm t-medium">Current effective window</span>
              </div>
              <div className="t-sm t-dim">
                An instance is flagged when average CPU stays under{' '}
                <strong>{num(config.cpu_threshold_percent)}%</strong> for{' '}
                <strong>{num(config.cpu_hours)} hours</strong> and it receives under{' '}
                <strong>{bytes(config.network_idle_bytes)}</strong> in total. Instances inside an Auto Scaling
                Group are always skipped.
              </div>
            </div>
          </CardBody>
        </Card>

        <div className="grid grid-2" style={{ marginTop: 'var(--s-7)' }}>
          <Card>
            <CardHeader title="EBS — orphaned volumes" subtitle="Detached, aged, and without a recent snapshot" />
            <CardBody className="stack stack-6">
              <Input
                type="number"
                label={LABELS.ebs_unattached_days}
                min={RANGES.ebs_unattached_days.min}
                max={RANGES.ebs_unattached_days.max}
                suffix="d"
                value={config.ebs_unattached_days}
                onChange={(e) => setNum('ebs_unattached_days', e.target.value)}
                error={errors.ebs_unattached_days}
                hint={RANGES.ebs_unattached_days.hint}
              />
              <Input
                type="number"
                label={LABELS.ebs_no_snapshot_days}
                min={RANGES.ebs_no_snapshot_days.min}
                max={RANGES.ebs_no_snapshot_days.max}
                suffix="d"
                value={config.ebs_no_snapshot_days}
                onChange={(e) => setNum('ebs_no_snapshot_days', e.target.value)}
                error={errors.ebs_no_snapshot_days}
                hint={RANGES.ebs_no_snapshot_days.hint}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="ELB — orphaned load balancers" subtitle="No healthy targets and no traffic" />
            <CardBody className="stack stack-6">
              <Input
                type="number"
                label={LABELS.lb_idle_days}
                min={RANGES.lb_idle_days.min}
                max={RANGES.lb_idle_days.max}
                suffix="d"
                value={config.lb_idle_days}
                onChange={(e) => setNum('lb_idle_days', e.target.value)}
                error={errors.lb_idle_days}
                hint={RANGES.lb_idle_days.hint}
              />
              <div className="panel">
                <div className="t-upper t-muted" style={{ marginBottom: 6 }}>
                  What this will not catch
                </div>
                <ul className="stack stack-3" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-2)' }}>
                  {[
                    'A load balancer that still has a healthy target, even with zero requests.',
                    'A load balancer in an Auto Scaling Group.',
                    'Anything matching an exclusion tag below.',
                  ].map((t) => (
                    <li key={t} className="row row-4 row-top">
                      <Icon name="x" size={12} className="t-danger" style={{ marginTop: 3, flex: 'none' }} />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ---------------- Exclusions ---------------- */}
      <section className="section">
        <SectionHeader
          title="Exclusion tags"
          icon="tag"
          description="Resources carrying any of these are skipped entirely — the strongest guardrail you have"
        />
        <Card>
          <CardHeader
            title="Skip rules (JSON)"
            subtitle='Map a tag key to the values that exempt a resource, e.g. { "Environment": ["prod"] }'
            action={
              <Button variant="ghost" size="sm" icon={showRaw ? 'eye' : 'code'} onClick={() => setShowRaw((s) => !s)}>
                {showRaw ? 'Preview' : 'Edit raw'}
              </Button>
            }
          />
          <CardBody className="stack stack-6">
            {errors.excluded_tags ? (
              <Alert variant="error">{errors.excluded_tags}</Alert>
            ) : null}
            {showRaw ? (
              <Textarea
                value={tagsText}
                onChange={(e) => {
                  setTagsText(e.target.value);
                  setDirty(true);
                }}
                rows={9}
                className="mono"
                spellCheck={false}
              />
            ) : excludedSummary.length ? (
              <div className="stack stack-5">
                {excludedSummary.map((row) => (
                  <div className="row row-6 row-wrap" key={row.key}>
                    <Badge tone="brand" mono>
                      {row.key}
                    </Badge>
                    <div className="row row-4 row-wrap">
                      {row.values.length ? (
                        row.values.map((v) => (
                          <Badge key={v} tone="neutral">
                            = {v}
                          </Badge>
                        ))
                      ) : (
                        <span className="t-xs t-muted">matches nothing — use this to block every value</span>
                      )}
                    </div>
                  </div>
                ))}
                <div className="t-xs t-muted">
                  {excludedSummary.reduce((a, r) => a + r.values.length, 0)} exempt combinations across{' '}
                  {excludedSummary.length} tag key{excludedSummary.length === 1 ? '' : 's'}.
                </div>
              </div>
            ) : (
              <EmptyTags />
            )}
          </CardBody>
        </Card>
      </section>

      {/* ---------------- Notifications ---------------- */}
      <section className="section">
        <SectionHeader title="Notifications" icon="bell" description="Who gets told when a request needs a decision" />
        <Card>
          <CardBody>
            <Input
              label="Recipients"
              placeholder="admin@company.com, finops@company.com"
              value={emailsText}
              onChange={(e) => {
                setEmailsText(e.target.value);
                setDirty(true);
              }}
              error={errors.notification_emails}
              hint="Comma-separated. Each address must be confirmed in the SNS topic before it can receive mail."
            />
            <div className="panel">
              <div className="t-sm t-dim">
                Notifications go out through AWS SNS when a finding reaches the approval stage. The subject line
                includes the resource type and monthly cost so it can be triaged from the inbox alone.
              </div>
            </div>
          </CardBody>
        </Card>
      </section>

      {/* ---------------- Raw payload ---------------- */}
      <section className="section">
        <SectionHeader title="Effective payload" icon="copy" description="Exactly what PUT /config will store" />
        <Card>
          <CardBody flush>
            <pre
              className="mono t-sm"
              style={{ padding: 'var(--s-7)', overflowX: 'auto', color: 'var(--text-2)', lineHeight: 1.7 }}
            >
              {JSON.stringify(
                {
                  ...config,
                  excluded_tags: excludedSummary.length ? JSON.parse(tagsText || '{}') : DEFAULT_CONFIG.excluded_tags,
                  notification_emails: emailsText.split(',').map((e) => e.trim()).filter(Boolean),
                },
                null,
                2
              )}
            </pre>
          </CardBody>
        </Card>
      </section>

      <div className="row row-end row-5 row-wrap" style={{ paddingBottom: 'var(--s-9)' }}>
        <Button variant="ghost" icon="refresh" onClick={load} disabled={saving}>
          Discard changes
        </Button>
        <Button variant="primary" icon="check" onClick={save} loading={saving} disabled={!dirty}>
          {saving ? 'Saving…' : 'Save configuration'}
        </Button>
      </div>
    </div>
  );
};

const LABELS = {
  cpu_threshold_percent: 'CPU threshold',
  cpu_hours: 'CPU window',
  network_idle_bytes: 'Network idle threshold',
  ebs_unattached_days: 'Unattached volume age',
  ebs_no_snapshot_days: 'Snapshot recency',
  lb_idle_days: 'Load balancer idle age',
};

function EmptyTags() {
  return (
    <div className="panel t-sm t-dim">
      No exclusion rules configured. Until you add some, any resource matching the idle profile will be flagged —
      including production ones. Consider adding at least an <code>Environment</code> rule.
    </div>
  );
}
