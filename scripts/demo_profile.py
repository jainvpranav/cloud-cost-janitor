"""Switch scan settings between the demo profile and production values.

    python scripts/demo_profile.py apply   --api https://<id>.execute-api.us-east-1.amazonaws.com/prod
    python scripts/demo_profile.py restore --api ...

Uses the public config API, so no AWS credentials are needed. API_URL can be set
instead of --api.
"""
import argparse
import json
import os
import sys
import urllib.request

DEMO = {
    "cpu_hours": 1,
    "cpu_threshold_percent": 5.0,
    # A fresh instance downloads a little at boot; CPU still separates idle from busy.
    "network_idle_bytes": 50 * 1024 * 1024,
    "ebs_unattached_days": 0,
    "lb_idle_days": 0,
    "scope_tags": {"CostJanitor": ["demo"]},
    "guardrails": {"dual_approval_threshold_usd": 10},
}

PRODUCTION = {
    "cpu_hours": 24,
    "cpu_threshold_percent": 5.0,
    "network_idle_bytes": 1024 * 1024,
    "ebs_unattached_days": 7,
    "lb_idle_days": 7,
    "scope_tags": {},
    "guardrails": {"dual_approval_threshold_usd": 100},
}


def request(method: str, url: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.load(res)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=["apply", "restore", "show"])
    parser.add_argument("--api", default=os.environ.get("API_URL"), help="API base URL (stack output ApiEndpoint)")
    args = parser.parse_args()
    if not args.api:
        sys.exit("Pass --api or set API_URL to the ApiEndpoint stack output.")
    base = args.api.rstrip("/")

    if args.action != "show":
        request("PUT", f"{base}/config", DEMO if args.action == "apply" else PRODUCTION)
        print(f"{'Demo' if args.action == 'apply' else 'Production'} profile applied.")

    config = request("GET", f"{base}/config")
    keys = ["cpu_hours", "network_idle_bytes", "ebs_unattached_days", "lb_idle_days", "scope_tags"]
    print(json.dumps({k: config.get(k) for k in keys} | {
        "dual_approval_threshold_usd": config.get("guardrails", {}).get("dual_approval_threshold_usd")}, indent=2))


if __name__ == "__main__":
    main()
