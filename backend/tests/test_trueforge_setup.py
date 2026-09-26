import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "trueforge_setup.py"
spec = importlib.util.spec_from_file_location("trueforge_setup", SCRIPT)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def args(**kw):
    base = dict(target="local", mcp_name="cost-janitor-local", mcp_url=setup.LOCAL_MCP_URL, model="p/m",
                chat_approval=False)
    return SimpleNamespace(**{**base, **kw})


def test_prompt_comes_from_agent_doc():
    prompt = setup.system_prompt()
    assert prompt.startswith("You are the Cost Janitor")
    assert "Do not call execute_teardown in this turn." in prompt


def test_chat_approval_is_opt_in():
    # Explicit [] so TrueForge's default (@destructive) does not pause on execute_teardown.
    default = setup.agent_manifest(args())["manifest"]["mcp_servers"][0]
    assert default["require_approval_for_tools"] == []
    opted_in = setup.agent_manifest(args(chat_approval=True))["manifest"]["mcp_servers"][0]
    assert "execute_teardown" in opted_in["require_approval_for_tools"]


def test_local_server_has_no_auth_and_aws_reads_key_from_env(monkeypatch):
    assert "auth" not in setup.mcp_manifest(args())
    monkeypatch.delenv("MCP_API_KEY", raising=False)
    with pytest.raises(SystemExit):
        setup.mcp_manifest(args(target="aws"))
    monkeypatch.setenv("MCP_API_KEY", "placeholder-for-test")
    assert setup.mcp_manifest(args(target="aws"))["auth"] == {
        "type": "header", "headers": {"x-api-key": "placeholder-for-test"}}
