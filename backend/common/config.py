from typing import Any, Dict

from .ddb import from_ddb

DEFAULT_GUARDRAILS: Dict[str, Any] = {
    "auto_approve_threshold_usd": 100.0,
    "dual_approval_threshold_usd": 100.0,
    "max_teardown_cost_usd": 1000.0,
    "blocked_tags": {
        "Environment": ["prod", "production", "Prod", "Production"],
        "CostJanitor": ["protect", "do-not-delete", "keep"],
    },
    "max_resources_per_run": 10,
    "dry_run_default": True,
    "require_snapshot_for_ebs": True,
    "approval_expiry_days": 7,
}

GUARDRAIL_FIELDS = set(DEFAULT_GUARDRAILS)


def load_item(table, key: str) -> Dict[str, Any]:
    item = table.get_item(Key={"config_key": key}).get("Item") or {}
    item = from_ddb(item)
    item.pop("config_key", None)
    return item


def load_guardrails(table) -> Dict[str, Any]:
    stored = load_item(table, "guardrails")
    merged = {**DEFAULT_GUARDRAILS, **{k: v for k, v in stored.items() if k in GUARDRAIL_FIELDS}}
    return merged


def required_approvals(monthly_cost: float, guardrails: Dict[str, Any]) -> int:
    return 2 if float(monthly_cost or 0) > float(guardrails["dual_approval_threshold_usd"]) else 1
