import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from .ddb import from_ddb, to_ddb

JOB_TTL_DAYS = 7


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_job_id(kind: str) -> str:
    return f"{kind}-{uuid.uuid4().hex[:12]}"


def create_job(table, kind: str, job_id: Optional[str] = None, **fields) -> Dict[str, Any]:
    job = {
        "job_id": job_id or new_job_id(kind),
        "kind": kind,
        "status": "QUEUED",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "ttl": int((datetime.now(timezone.utc) + timedelta(days=JOB_TTL_DAYS)).timestamp()),
        **fields,
    }
    table.put_item(Item=to_ddb(job))
    return job


def update_job(table, job_id: Optional[str], status: str, **fields) -> None:
    if not job_id:
        return
    values = {"status": status, "updated_at": now_iso(), **fields}
    names = {f"#{k}": k for k in values}
    table.update_item(
        Key={"job_id": job_id},
        UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in values),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=to_ddb({f":{k}": v for k, v in values.items()}),
    )


def get_job(table, job_id: str) -> Optional[Dict[str, Any]]:
    item = table.get_item(Key={"job_id": job_id}).get("Item")
    return from_ddb(item) if item else None
