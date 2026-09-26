import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from boto3.dynamodb.conditions import Key

from .ddb import from_ddb, to_ddb

TTL_DAYS = 7
SUMMARY_LIMIT = 400


def _day(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def summarize(value: Any) -> str:
    text = value if isinstance(value, str) else str(value)
    return text if len(text) <= SUMMARY_LIMIT else text[:SUMMARY_LIMIT] + "…"


def record(table, tool: str, args: Dict[str, Any], result: Any, ok: bool, actor: str = "agent",
           session: Optional[str] = None) -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    item = {
        "day": _day(now),
        "ts": f"{now.isoformat()}#{uuid.uuid4().hex[:6]}",
        "at": now.isoformat(),
        "tool": tool,
        "actor": actor,
        "session": session or "",
        "args_summary": summarize(args),
        "result_summary": summarize(result),
        "ok": ok,
        "ttl": int((now + timedelta(days=TTL_DAYS)).timestamp()),
    }
    table.put_item(Item=to_ddb(item))
    return item


def recent(table, limit: int = 50, since: Optional[str] = None) -> List[Dict[str, Any]]:
    now = datetime.now(timezone.utc)
    items: List[Dict[str, Any]] = []
    for day in (_day(now), _day(now - timedelta(days=1))):
        cond = Key("day").eq(day)
        if since:
            cond = cond & Key("ts").gt(since)
        resp = table.query(KeyConditionExpression=cond, ScanIndexForward=False, Limit=limit - len(items))
        items.extend(from_ddb(resp.get("Items", [])))
        if len(items) >= limit:
            break
    return items
