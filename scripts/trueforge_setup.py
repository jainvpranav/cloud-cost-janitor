#!/usr/bin/env python3
"""Register the Cost Janitor MCP server and agent in a TrueForge server.

Run it after you have added a model provider in the TrueForge UI (Settings → Model providers).
Safe to re-run: the MCP server is replaced and the agent is updated in place.

    # local, simulated AWS (scripts/local_stack.py on :8787)
    python scripts/trueforge_setup.py --model anthropic/claude-sonnet-5

    # AWS: key is read from the environment, never from the command line
    MCP_API_KEY=... python scripts/trueforge_setup.py --target aws \\
        --mcp-url https://<api-id>.execute-api.us-east-1.amazonaws.com/prod/mcp --model anthropic/claude-sonnet-5

TrueForge blocks MCP servers on private addresses. For the local target start it with
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' (see agent/janitor-agent.md).
Only the Python standard library is used.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROMPT_FILE = ROOT / "agent" / "janitor-agent.md"
AGENT_NAME = "cost-janitor"
LOCAL_MCP_URL = "http://127.0.0.1:8787/prod/mcp"


def call(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{base}{path}", data=data, method=method,
                                 headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            pass
        raise SystemExit(f"{method} {path} failed ({e.code}): {detail}")
    except urllib.error.URLError as e:
        raise SystemExit(f"Cannot reach TrueForge at {base}: {e.reason}. Is `npx @truefoundry/trueforge` running?")


def system_prompt():
    """The ```text block under '## System prompt' in agent/janitor-agent.md, so the prompt lives in one place."""
    doc = PROMPT_FILE.read_text()
    m = re.search(r"## System prompt\s+```text\n(.*?)\n```", doc, re.S)
    if not m:
        raise SystemExit(f"No ```text block under '## System prompt' in {PROMPT_FILE}")
    return m.group(1).strip()


def mcp_manifest(args):
    manifest = {
        "type": "remote",
        "name": args.mcp_name,
        "url": args.mcp_url,
        "description": "Cost Janitor: scan AWS for idle EC2, EBS and load balancers, price them, draft teardown "
                       "plans and execute teardowns that a person approved in the dashboard.",
    }
    if args.target == "aws":
        # TODO: Securely load this value from an environment variable or secrets vault. Do not hardcode.
        key = os.environ.get("MCP_API_KEY")
        if not key:
            raise SystemExit("Set MCP_API_KEY in the environment (see docs/aws-setup.md step 8).")
        manifest["auth"] = {"type": "header", "headers": {"x-api-key": key}}
    return manifest


def agent_manifest(args):
    return {
        "name": AGENT_NAME,
        "description": "Finds idle AWS resources, prices them, drafts a teardown plan and deletes only what "
                       "people approved in the dashboard.",
        "manifest": {
            "model": {"name": args.model, "params": {"temperature": 0}},
            "instructions": system_prompt(),
            "mcp_servers": [{
                "name": args.mcp_name,
                "enable_tools": ["@all"],
                "preload": True,
                # Second gate on top of the dashboard approval: TrueForge pauses the chat before any
                # teardown call. The literal name keeps working even if annotations change.
                "require_approval_for_tools": ["execute_teardown", "@destructive"],
            }],
            "config": {
                "iteration_limit": 60,
                "sandbox": {"enabled": False},
                "dynamic_sub_agents": {"enabled": False},
                "web_search": {"enabled": False},
            },
        },
    }


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--trueforge", default="http://localhost:8790", help="TrueForge base URL")
    p.add_argument("--target", choices=["local", "aws"], default="local")
    p.add_argument("--mcp-url", help=f"MCP endpoint (default for local: {LOCAL_MCP_URL}; McpEndpoint output for aws)")
    p.add_argument("--mcp-name", help="Connector name in TrueForge (default cost-janitor-<target>)")
    p.add_argument("--model", help="Model FQN provider/model, e.g. anthropic/claude-sonnet-5")
    p.add_argument("--mcp-only", action="store_true", help="Register the MCP server only, skip the agent")
    args = p.parse_args()
    args.mcp_name = args.mcp_name or f"cost-janitor-{args.target}"
    args.mcp_url = args.mcp_url or (LOCAL_MCP_URL if args.target == "local" else None)
    if not args.mcp_url:
        p.error("--mcp-url is required for --target aws")
    api = f"{args.trueforge.rstrip('/')}/api/v1"

    call(api, "PUT", "/settings/mcp-servers", {"manifest": mcp_manifest(args)})
    tools = call(api, "GET", f"/mcp-servers/{args.mcp_name}/tools")["data"]
    print(f"MCP server {args.mcp_name}: {len(tools)} tools ({', '.join(t['name'] for t in tools)})")

    if args.mcp_only:
        return
    models = [m.get("name") or m.get("fqn") or m.get("id") for m in call(api, "GET", "/models")["data"]]
    if not args.model:
        raise SystemExit(f"Pass --model. Configured models: {', '.join(map(str, models)) or 'none, add a provider first'}")

    body = agent_manifest(args)
    existing = [a for a in call(api, "GET", f"/agents?agent_name={AGENT_NAME}")["data"] if a["name"] == AGENT_NAME]
    if existing:
        agent_id = existing[0]["id"]
        call(api, "PUT", f"/agents/{agent_id}", {k: body[k] for k in ("description", "manifest")})
        print(f"Updated agent {AGENT_NAME} ({agent_id})")
    else:
        agent_id = call(api, "POST", "/agents", body)["data"]["id"]
        print(f"Created agent {AGENT_NAME} ({agent_id})")
    print(f"Model {args.model}; approval required for execute_teardown. Open {args.trueforge} and pick {AGENT_NAME}.")


if __name__ == "__main__":
    sys.exit(main())
