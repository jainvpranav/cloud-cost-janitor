import functools
import os
from typing import Any, Callable, Dict, List, Literal, Optional

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations

import janitor_tools as jt
from common import activity

INSTRUCTIONS = (
    "Tools for finding and cleaning up idle AWS resources (EC2, EBS, load balancers). "
    "Read tools are safe. draft_teardown_plan only creates approval requests. "
    "execute_teardown deletes a resource and works only after a person approved it in the dashboard."
)

mcp = MCPServer("cost-janitor", instructions=INSTRUCTIONS, version="1.0.0")

# Hints let agent harnesses pick tools by effect, e.g. TrueForge's @read-only and @destructive selectors.
# They are advisory: the approval check in execute_teardown is what actually blocks deletes.
READ = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=True)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=True)
DESTRUCTIVE = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=True)


def logged(fn: Callable) -> Callable:
    """Record every call in the activity table so the dashboard can show it live."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        ok, result = True, None
        try:
            result = fn(*args, **kwargs)
            if isinstance(result, dict) and result.get("refused"):
                ok = False
            return result
        except jt.ToolError as e:
            ok, result = False, f"error: {e}"
            raise ValueError(str(e)) from e
        except Exception as e:
            ok, result = False, f"error: {e}"
            raise
        finally:
            _record(fn.__name__, kwargs, result, ok)

    return wrapper


def _record(tool: str, args: Dict[str, Any], result: Any, ok: bool) -> None:
    if not os.environ.get("ACTIVITY_TABLE"):
        return
    try:
        activity.record(jt.table("ACTIVITY_TABLE"), tool, args, _summary(tool, result), ok)
    except Exception as e:
        print(f"Could not record activity for {tool}: {e}")


def _summary(tool: str, result: Any) -> str:
    """One readable line for the dashboard's activity feed."""
    if not isinstance(result, dict):
        return str(result)
    if result.get("refused"):
        return result["reason"]
    if "items" in result and "count" in result:
        return f"{result['count']} found, ${result.get('monthly_total_usd', 0):.2f}/mo"
    if tool == "get_cost_summary":
        o, r = result["open_waste"], result["reclaimed"]
        return f"Open ${o['monthly_usd']:.2f}/mo ({o['count']}), reclaimed ${r['monthly_usd']:.2f}/mo ({r['count']})"
    if tool == "draft_teardown_plan":
        return (f"{len(result['items'])} items sent for approval, {len(result['skipped'])} skipped, "
                f"${result['monthly_savings_usd']:.2f}/mo")
    if tool == "record_assessment":
        a = result["assessment"]
        return f"{result['finding_id']}: {a['recommendation']}, {a['risk_assessment']} risk, {a['confidence']:.0%}"
    if tool == "get_approval_status":
        return f"{len(result['approved'])} of {len(result['items'])} approved"
    if tool == "get_job_status":
        return f"{result.get('kind', 'job')} {result.get('job_id')}: {result.get('status')}"
    if "job_id" in result:
        kind = "Teardown" if tool == "execute_teardown" else "Scan"
        return f"{kind} job {result['job_id']} queued"
    return ", ".join(f"{k}={v}" for k, v in result.items())[:400]


@mcp.tool(annotations=WRITE)
@logged
def run_scan() -> dict:
    """Start a scan of the AWS account for idle EC2 instances, orphaned EBS volumes and idle load balancers.

    Runs in the background and returns a job_id. Poll get_job_status until it finishes, then use the
    list_* tools to see what was found.
    """
    return jt.start_scan()


@mcp.tool(annotations=READ)
@logged
def get_job_status(job_id: str) -> dict:
    """Get the status of a scan or teardown job: QUEUED, RUNNING, SUCCEEDED, FAILED or REFUSED, plus its result."""
    return jt.job_status(job_id)


@mcp.tool(annotations=READ)
@logged
def list_idle_instances() -> dict:
    """List open findings for running EC2 instances with low CPU and network traffic, with evidence and monthly cost."""
    return jt.list_open("EC2")


@mcp.tool(annotations=READ)
@logged
def list_orphaned_volumes() -> dict:
    """List open findings for EBS volumes that are not attached to any instance, with age, snapshot history and cost."""
    return jt.list_open("EBS")


@mcp.tool(annotations=READ)
@logged
def list_idle_load_balancers() -> dict:
    """List open findings for load balancers with no healthy targets and no traffic, with monthly cost."""
    return jt.list_open("ELB")


@mcp.tool(annotations=READ)
@logged
def get_cost_summary() -> dict:
    """Summarize open waste (monthly and annual, by resource type), items awaiting approval, and savings already reclaimed."""
    return jt.cost_summary()


@mcp.tool(annotations=WRITE)
@logged
def record_assessment(
    finding_id: str,
    risk: Literal["low", "medium", "high"],
    recommendation: Literal["delete", "keep", "investigate", "downsize"],
    confidence: float,
    reasoning: str,
) -> dict:
    """Save your assessment of one finding so reviewers see it in the dashboard.

    risk is the risk of deleting the resource. confidence is 0 to 1. reasoning should cite the evidence
    (CPU, traffic, age, tags) in one to three sentences.
    """
    return jt.assess(finding_id, risk, recommendation, confidence, reasoning)


@mcp.tool(annotations=WRITE)
@logged
def draft_teardown_plan(finding_ids: List[str]) -> dict:
    """Create approval requests for the given findings and return the teardown plan with savings.

    This deletes nothing. Protected resources (e.g. tagged Environment=prod) are skipped. Items costing more
    than the dual-approval threshold need two different approvers. After calling this, stop and tell the user
    the plan is waiting for approval in the dashboard.
    """
    return jt.draft_plan(finding_ids)


@mcp.tool(annotations=READ)
@logged
def get_approval_status(approval_ids: Optional[List[str]] = None) -> dict:
    """Show whether approval requests are PENDING, APPROVED or REJECTED and who voted. Omit ids to list all open ones."""
    return jt.approval_status(approval_ids)


@mcp.tool(annotations=DESTRUCTIVE)
@logged
def execute_teardown(approval_id: str) -> dict:
    """Delete the resource behind one APPROVED approval request. Returns a job_id to poll.

    Refuses if the request is not APPROVED. Only people can approve, in the dashboard. The teardown re-checks
    guardrails and that the resource is still idle, and snapshots EBS volumes before deleting them.
    """
    return jt.start_teardown(approval_id)


def create_app(local: bool = False):
    # Behind API Gateway the Host header is the execute-api domain, and the API key check already
    # guards the endpoint, so DNS rebinding protection is only kept for local runs.
    security = None if local else TransportSecuritySettings(enable_dns_rebinding_protection=False)
    return mcp.streamable_http_app(
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=True,
        transport_security=security,
        host="127.0.0.1" if local else "0.0.0.0",
    )
