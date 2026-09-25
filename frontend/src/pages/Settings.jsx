import React, { useState, useEffect } from "react";
import { configApi } from "../api/client";
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Input,
  Select,
  Alert,
} from "../components/UI";

const DEFAULT_CONFIG = {
  role_arn: "",
  account_id: "",
  cpu_threshold_percent: 5,
  cpu_hours: 24,
  network_idle_bytes: 1048576,
  ebs_unattached_days: 7,
  ebs_no_snapshot_days: 30,
  lb_idle_days: 7,
  excluded_tags: {
    Environment: ["prod", "production"],
    CostJanitor: ["ignore", "do-not-delete"],
  },
  notification_emails: ["admin@company.com"],
};

export const Settings = () => {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [excludedTags, setExcludedTags] = useState("");
  const [notificationEmails, setNotificationEmails] = useState("");

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const response = await configApi.get();
      if (response.data) {
        const loaded = { ...DEFAULT_CONFIG, ...response.data };
        setConfig(loaded);
        setExcludedTags(JSON.stringify(loaded.excluded_tags, null, 2));
        setNotificationEmails((loaded.notification_emails || []).join(", "));
      }
    } catch (err) {
      console.error("Failed to load config:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      let parsedTags;
      try {
        parsedTags = JSON.parse(excludedTags);
      } catch {
        setMessage({ type: "error", text: "Invalid JSON for excluded tags" });
        setSaving(false);
        return;
      }

      const emails = notificationEmails
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);

      const payload = {
        ...config,
        excluded_tags: parsedTags,
        notification_emails: emails,
      };

      await configApi.update(payload);
      setConfig(payload);
      setMessage({ type: "success", text: "Configuration saved successfully" });
    } catch (err) {
      console.error("Save failed:", err);
      setMessage({ type: "error", text: "Failed to save configuration" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: "40px", textAlign: "center" }}>Loading...</div>
    );
  }

  return (
    <div className="container">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">
          Configure scan parameters and notifications
        </p>
      </div>

      {message && <Alert variant={message.type}>{message.text}</Alert>}

      <Card>
        <CardHeader>
          <h3 style={{ margin: 0 }}>AWS Configuration</h3>
        </CardHeader>
        <CardBody>
          <div className="grid grid-2">
            <Input
              label="Role ARN"
              value={config.role_arn}
              onChange={(e) =>
                setConfig({ ...config, role_arn: e.target.value })
              }
              placeholder="arn:aws:iam::123456789012:role/CostJanitorScanner"
              help="Cross-account role for scanner to assume"
            />
            <Input
              label="Account ID"
              value={config.account_id}
              onChange={(e) =>
                setConfig({ ...config, account_id: e.target.value })
              }
              placeholder="123456789012"
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 style={{ margin: 0 }}>Scan Thresholds</h3>
        </CardHeader>
        <CardBody>
          <div className="grid grid-3">
            <Input
              label="CPU Threshold (%)"
              type="number"
              min="0"
              max="100"
              value={config.cpu_threshold_percent}
              onChange={(e) =>
                setConfig({
                  ...config,
                  cpu_threshold_percent: parseFloat(e.target.value) || 0,
                })
              }
            />
            <Input
              label="CPU Window (hours)"
              type="number"
              min="1"
              max="168"
              value={config.cpu_hours}
              onChange={(e) =>
                setConfig({
                  ...config,
                  cpu_hours: parseInt(e.target.value) || 24,
                })
              }
            />
            <Input
              label="Network Idle Threshold (bytes)"
              type="number"
              min="0"
              value={config.network_idle_bytes}
              onChange={(e) =>
                setConfig({
                  ...config,
                  network_idle_bytes: parseInt(e.target.value) || 0,
                })
              }
              help="Max network in over window to consider idle"
            />
            <Input
              label="EBS Unattached (days)"
              type="number"
              min="1"
              max="90"
              value={config.ebs_unattached_days}
              onChange={(e) =>
                setConfig({
                  ...config,
                  ebs_unattached_days: parseInt(e.target.value) || 7,
                })
              }
            />
            <Input
              label="EBS No Snapshot (days)"
              type="number"
              min="1"
              max="365"
              value={config.ebs_no_snapshot_days}
              onChange={(e) =>
                setConfig({
                  ...config,
                  ebs_no_snapshot_days: parseInt(e.target.value) || 30,
                })
              }
            />
            <Input
              label="LB Idle (days)"
              type="number"
              min="1"
              max="90"
              value={config.lb_idle_days}
              onChange={(e) =>
                setConfig({
                  ...config,
                  lb_idle_days: parseInt(e.target.value) || 7,
                })
              }
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 style={{ margin: 0 }}>Exclusion Tags (JSON)</h3>
        </CardHeader>
        <CardBody>
          <div className="form-group">
            <label>Resources with these tags will be skipped</label>
            <textarea
              value={excludedTags}
              onChange={(e) => setExcludedTags(e.target.value)}
              rows={8}
              style={{
                fontFamily: "monospace",
                fontSize: "13px",
                minHeight: "200px",
              }}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 style={{ margin: 0 }}>Notification Emails</h3>
        </CardHeader>
        <CardBody>
          <Input
            label="Emails (comma-separated)"
            value={notificationEmails}
            onChange={(e) => setNotificationEmails(e.target.value)}
            placeholder="admin@company.com, finops@company.com"
            help="Approval notifications sent to these addresses"
          />
        </CardBody>
      </Card>

      <div style={{ display: "flex", gap: "16px", justifyContent: "flex-end" }}>
        <Button variant="secondary" onClick={loadConfig}>
          Reset
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Configuration"}
        </Button>
      </div>
    </div>
  );
};
