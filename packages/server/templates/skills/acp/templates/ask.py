#!/usr/bin/env python3
"""ask.py — call an agent over ACP: remote halo server, local Claude Code, or local Kiro. See SKILL.md."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from typing import Any


def fail(msg: str, code: int = 1) -> None:
    sys.stderr.write(f"[ask-acp-agent] {msg}\n")
    sys.exit(code)


def main() -> None:
    p = argparse.ArgumentParser(prog="ask.py", description="Ask a remote agent over ACP.")
    p.add_argument("question")
    p.add_argument("--kind", default="halo", choices=["halo", "claude", "kiro"],
                   help="halo: remote halo server via `halo acp`; claude: local Claude Code via `claude-agent-acp`; kiro: local Kiro via `kiro-cli acp`.")
    p.add_argument("--host")
    p.add_argument("--port")
    p.add_argument("--token")
    p.add_argument("--workspace")
    p.add_argument("--cwd", default=None, help="claude kind: working directory for the session (defaults to CWD).")
    p.add_argument("--agent-id", default=None)
    p.add_argument("--session-id", default=None)
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--halo-bin", default=None)
    p.add_argument("--claude-bin", default=None)
    p.add_argument("--kiro-bin", default=None)
    args = p.parse_args()

    if args.kind == "claude":
        bin_ = args.claude_bin or os.environ.get("CLAUDE_ACP_BIN") or "claude-agent-acp"
        if shutil.which(bin_) is None and not os.path.isabs(bin_):
            fail(f"`{bin_}` not found in PATH. npm install -g @agentclientprotocol/claude-agent-acp, or set --claude-bin.", 2)
        cmd = [bin_]
    elif args.kind == "kiro":
        bin_ = args.kiro_bin or os.environ.get("KIRO_ACP_BIN") or "kiro-cli"
        if shutil.which(bin_) is None and not os.path.isabs(bin_):
            fail(f"`{bin_}` not found in PATH. Install Kiro CLI, or set --kiro-bin.", 2)
        # --trust-all-tools: the binding is a headless relay; there's no human
        # at this end to answer kiro's per-tool permission prompts.
        cmd = [bin_, "acp", "--trust-all-tools"]
        if args.agent_id and not args.agent_id.startswith("{{"):
            cmd += ["--agent", args.agent_id]
    else:
        for k in ("host", "port", "token", "workspace"):
            if not getattr(args, k):
                fail(f"--{k} is required for --kind halo", 2)
        halo = args.halo_bin or os.environ.get("HALO_BIN") or "halo"
        if shutil.which(halo) is None and not os.path.isabs(halo):
            fail(f"`{halo}` not found in PATH. Install @turmind/halo or set --halo-bin.", 2)
        cmd = [halo, "acp", "--host", args.host, "--port", str(args.port),
               "--token", args.token, "--workspace", args.workspace]
    # Drop `--agent-id` when blank OR an unsubstituted `{{...}}` literal.
    # Both mean "user hasn't configured this optional field" — the first
    # because settings.yaml has `agent_id: ""`, the second because the
    # key isn't in settings.yaml at all and halo's shell_exec
    # substitute leaves the placeholder verbatim (its "fail loud"
    # contract for required params). For an optional flag like this, we
    # want graceful degrade, not a literal-as-value going to acp.
    aid = (args.agent_id or "").strip()
    if aid and not (aid.startswith("{{") and aid.endswith("}}")):
        cmd += ["--agent-id", aid]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, bufsize=1)
    assert proc.stdin and proc.stdout and proc.stderr

    def _drain_stderr() -> None:
        for line in proc.stderr:
            sys.stderr.write(line)
    threading.Thread(target=_drain_stderr, daemon=True).start()

    next_id = 1
    pending: dict[int, dict[str, Any]] = {}
    chunks: list[str] = []

    def send(method: str, params: dict[str, Any] | None = None) -> int:
        nonlocal next_id
        rid = next_id
        next_id += 1
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()
        return rid

    def wait_for(rid: int, deadline: float) -> dict[str, Any]:
        while True:
            if rid in pending:
                return pending.pop(rid)
            if time.time() > deadline:
                proc.kill()
                fail(f"timeout waiting for response to request {rid}", 124)
            line = proc.stdout.readline()
            if line == "":
                rc = proc.wait(timeout=1)
                fail(f"adapter exited prematurely (rc={rc})", rc or 1)
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                sys.stderr.write(f"[ask-acp-agent] non-JSON: {line[:200]}\n")
                continue
            if "id" in msg and ("result" in msg or "error" in msg):
                pending[msg["id"]] = msg
                continue
            method = msg.get("method")
            if method == "session/update":
                update = (msg.get("params") or {}).get("update") or {}
                if update.get("sessionUpdate") == "agent_message_chunk":
                    text = (update.get("content") or {}).get("text", "")
                    if text:
                        chunks.append(text)

    deadline = time.time() + args.timeout
    try:
        rid = send("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        resp = wait_for(rid, deadline)
        if "error" in resp:
            fail(f"initialize failed: {resp['error']}")

        if args.session_id:
            # ACP session/load requires cwd + mcpServers (same as session/new);
            # kiro-cli exits silently if they're missing.
            load_params: dict[str, Any] = {"sessionId": args.session_id}
            if args.kind in ("claude", "kiro"):
                load_params["cwd"] = args.cwd or os.getcwd()
                load_params["mcpServers"] = []
            rid = send("session/load", load_params)
            resp = wait_for(rid, deadline)
            if "error" in resp:
                fail(f"session/load failed: {resp['error']}")
            session_id = args.session_id
        else:
            new_params = {"cwd": args.cwd or os.getcwd(), "mcpServers": []} if args.kind in ("claude", "kiro") else {}
            rid = send("session/new", new_params)
            resp = wait_for(rid, deadline)
            if "error" in resp:
                fail(f"session/new failed: {resp['error']}")
            session_id = resp["result"]["sessionId"]

        rid = send("session/prompt", {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": args.question}],
        })
        resp = wait_for(rid, deadline)
        if "error" in resp:
            fail(f"session/prompt failed: {resp['error']}")
        stop_reason = resp["result"].get("stopReason", "unknown")

        sys.stdout.write(f"SESSION: {session_id}\n---\n")
        sys.stdout.write("".join(chunks).rstrip() + "\n")

        if stop_reason != "end_turn":
            sys.stderr.write(f"[ask-acp-agent] stopReason={stop_reason}\n")
    finally:
        try: proc.stdin.close()
        except Exception: pass
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill()


if __name__ == "__main__":
    main()
