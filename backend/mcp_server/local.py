"""Run the MCP server on localhost for TrueForge development.

    cd backend && ../.venv/bin/python mcp_server/local.py --port 8000

Uses your current AWS profile and the table/function names from the deployed stack
(export them first, see docs/development.md).
"""
import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "scanner"), str(HERE.parent)]

import uvicorn  # noqa: E402

from server import create_app  # noqa: E402

REQUIRED = ["FINDINGS_TABLE", "APPROVALS_TABLE", "CONFIG_TABLE", "JOBS_TABLE", "ACTIVITY_TABLE",
            "SCANNER_FUNCTION", "TEARDOWN_FUNCTION"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print(f"Warning: {', '.join(missing)} not set; tools that touch AWS will fail.")
    uvicorn.run(create_app(local=True), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
