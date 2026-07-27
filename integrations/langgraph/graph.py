"""A self-healing CI agent with interlock as its approval gate.

The graph does the fetching, the PR opening and the LLM work. It does not decide
what is allowed — it shells out to `interlock` for that, so the policy lives in
a reviewed file rather than in this code.

    fetch_logs -> diagnose -> gate ->  auto   -> create_pr
                                    -> hold   -> approval_gate -> create_pr
                                    -> refuse -> notify_human (end)

Not exercised by this repo's CI: it needs langgraph, a GitHub token and network
access. The interlock half is covered by `npm test`.

    pip install -r requirements.txt
    python graph.py --repo acme/api --run 4530
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
from typing import Literal, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

INTERLOCK = os.environ.get("INTERLOCK_BIN", "interlock")
REPO_ROOT = os.environ.get("INTERLOCK_ROOT", ".")


class AgentState(TypedDict, total=False):
    repo_name: str
    run_id: int
    error_log: str

    # everything below is filled in by interlock, not by the model
    failure_class: str
    fingerprint: str
    diagnosis: str
    proposed_patch: str | None
    verdict: Literal["auto", "hold", "refuse", "pass"]
    reason: str
    hold_id: str
    files: list[str]

    human_approved: bool
    approved_by: str
    pr_url: str


def _interlock(*args: str) -> dict:
    """Run interlock and parse its JSON. Exit codes are verdicts, not errors."""
    result = subprocess.run(
        [INTERLOCK, *args, "--json", "--root", REPO_ROOT],
        capture_output=True,
        text=True,
    )
    if not result.stdout.strip():
        raise RuntimeError(f"interlock produced no output: {result.stderr.strip()}")
    return json.loads(result.stdout)


# --------------------------------------------------------------- nodes


def fetch_logs(state: AgentState) -> AgentState:
    """Pull the failed run's log. Replace with PyGithub if you prefer."""
    log = subprocess.run(
        ["gh", "run", "view", str(state["run_id"]), "--log-failed",
         "--repo", state["repo_name"]],
        capture_output=True, text=True, check=True,
    ).stdout
    path = f".interlock/run-{state['run_id']}.log"
    os.makedirs(".interlock", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(log)
    return {"error_log": path}


def diagnose(state: AgentState) -> AgentState:
    """Classify the failure. No policy applied, no side effects."""
    out = _interlock("diagnose", state["error_log"])
    return {
        "failure_class": out["class"],
        "fingerprint": out["fingerprint"],
        "diagnosis": out["label"],
        "proposed_patch": out["proposal"].get("patch"),
    }


def diagnose_with_llm(state: AgentState) -> AgentState:
    """Only reached when no rule matched.

    interlock covers the boring, deterministic failures. This is the seam for
    everything else — and note that whatever the model returns still goes
    through the gate below. An LLM cannot widen its own scope here.
    """
    from langchain_anthropic import ChatAnthropic  # imported late; optional

    model = ChatAnthropic(model="claude-opus-4-5", max_tokens=2000)
    with open(state["error_log"], encoding="utf-8") as fh:
        log = fh.read()[-8000:]

    reply = model.invoke(
        "You are diagnosing a failed CI run. Reply with a one-line cause, then a "
        "unified diff, or the word NONE if no safe patch exists.\n\n" + log
    ).content
    cause, _, patch = reply.partition("\n")
    return {
        "diagnosis": cause.strip(),
        "proposed_patch": None if "NONE" in patch else patch.strip(),
    }


def gate(state: AgentState) -> AgentState:
    """Ask interlock what is allowed. This is the only authority in the graph."""
    out = _interlock(
        "gate", state["error_log"],
        "--repo", state["repo_name"], "--run", str(state["run_id"]),
    )
    return {
        "verdict": out["verdict"],
        "reason": out["reason"],
        "hold_id": out["id"],
        "files": out.get("files", []),
        "proposed_patch": (out.get("proposal") or {}).get("patch"),
    }


def approval_gate(state: AgentState) -> AgentState:
    """Freeze the graph until a person answers.

    interrupt() suspends the run and the checkpointer writes the state to
    SQLite. The process can exit. Resume days later with:

        graph.invoke(Command(resume={"approved": True, "by": "Your Name"}),
                     config={"configurable": {"thread_id": thread}})
    """
    notify_slack(state)

    answer = interrupt({
        "hold_id": state["hold_id"],
        "class": state["failure_class"],
        "fingerprint": state["fingerprint"],
        "diagnosis": state["diagnosis"],
        "files": state["files"],
        "patch": state["proposed_patch"],
        "reason": state["reason"],
    })

    approved = bool(answer.get("approved"))
    by = answer.get("by", "unknown")

    # Record the decision in the ledger, not just in graph state. The ledger is
    # what outlives this process — and what issues the warrant that stops the
    # same failure asking again.
    subprocess.run(
        [INTERLOCK, "clear" if approved else "reject", state["hold_id"],
         "--root", REPO_ROOT, "--by", by],
        check=True, capture_output=True,
    )
    return {"human_approved": approved, "approved_by": by}


def notify_slack(state: AgentState) -> None:
    """Post the held decision. interlock builds the Block Kit payload."""
    url = os.environ.get("SLACK_WEBHOOK_URL")
    if not url:
        return
    payload = subprocess.run(
        [INTERLOCK, "gate", state["error_log"], "--slack", "--root", REPO_ROOT,
         "--repo", state["repo_name"], "--run", str(state["run_id"])],
        capture_output=True, text=True,
    ).stdout
    subprocess.run(
        ["curl", "-s", "-X", "POST", "-H", "Content-type: application/json",
         "-d", payload, url],
        check=False, capture_output=True,
    )


def create_pr(state: AgentState) -> AgentState:
    """Branch, apply, push, open. Only ever reached with an allowed patch."""
    branch = f"interlock/{state['failure_class']}-{state['run_id']}"
    patch_file = f".interlock/{state['hold_id']}.diff"
    with open(patch_file, "w", encoding="utf-8") as fh:
        fh.write(state["proposed_patch"] or "")

    for cmd in (
        ["git", "checkout", "-b", branch],
        ["git", "apply", patch_file],
        ["git", "commit", "-am", f"fix(ci): {state['diagnosis']}"],
        ["git", "push", "-u", "origin", branch],
    ):
        subprocess.run(cmd, check=True, cwd=REPO_ROOT, capture_output=True)

    body = (
        f"Automated pipeline repair.\n\n"
        f"- **class** `{state['failure_class']}`\n"
        f"- **fingerprint** `{state['fingerprint']}`\n"
        f"- **verdict** {state['verdict']} — {state['reason']}\n"
        f"- **cleared by** {state.get('approved_by', 'policy (pre-cleared)')}\n\n"
        f"Decision recorded in `.interlock/ledger.jsonl`."
    )
    url = subprocess.run(
        ["gh", "pr", "create", "--title", f"fix(ci): {state['diagnosis']}",
         "--body", body],
        capture_output=True, text=True, check=True, cwd=REPO_ROOT,
    ).stdout.strip()
    return {"pr_url": url}


def notify_human(state: AgentState) -> AgentState:
    """Refused. Nothing automatic happens; a person owns this one."""
    print(f"refused: {state['reason']}")
    return {"human_approved": False}


# ----------------------------------------------------------------- edges


def route_after_diagnose(state: AgentState) -> str:
    return "diagnose_with_llm" if state["failure_class"] == "unknown" else "gate"


def route_after_gate(state: AgentState) -> str:
    return {"auto": "create_pr", "hold": "approval_gate"}.get(
        state["verdict"], "notify_human"
    )


def route_after_approval(state: AgentState) -> str:
    return "create_pr" if state["human_approved"] else END


def build(checkpoint_path: str = ".interlock/checkpoints.sqlite"):
    graph = StateGraph(AgentState)
    for name, fn in [
        ("fetch_logs", fetch_logs),
        ("diagnose", diagnose),
        ("diagnose_with_llm", diagnose_with_llm),
        ("gate", gate),
        ("approval_gate", approval_gate),
        ("create_pr", create_pr),
        ("notify_human", notify_human),
    ]:
        graph.add_node(name, fn)

    graph.add_edge(START, "fetch_logs")
    graph.add_edge("fetch_logs", "diagnose")
    # The explicit destination lists are not decoration — they let LangGraph
    # draw and validate the graph instead of inferring edges at runtime.
    graph.add_conditional_edges("diagnose", route_after_diagnose, ["diagnose_with_llm", "gate"])
    graph.add_edge("diagnose_with_llm", "gate")
    graph.add_conditional_edges("gate", route_after_gate, ["create_pr", "approval_gate", "notify_human"])
    graph.add_conditional_edges("approval_gate", route_after_approval, ["create_pr", END])
    graph.add_edge("create_pr", END)
    graph.add_edge("notify_human", END)

    # SqliteSaver.from_conn_string() is a context manager — it closes the
    # connection on exit, so it is wrong for a run that pauses for days and
    # resumes in a different process. Construct it directly instead.
    os.makedirs(os.path.dirname(checkpoint_path) or ".", exist_ok=True)
    conn = sqlite3.connect(checkpoint_path, check_same_thread=False)
    return graph.compile(checkpointer=SqliteSaver(conn))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", required=True, help="owner/name")
    ap.add_argument("--run", required=True, type=int, help="failed run id")
    ap.add_argument("--resume", metavar="THREAD", help="resume a held thread")
    ap.add_argument("--approve", action="store_true")
    ap.add_argument("--by", default=os.environ.get("USER", "unknown"))
    args = ap.parse_args()

    app = build()
    thread = args.resume or f"{args.repo}:{args.run}"
    config = {"configurable": {"thread_id": thread}}

    if args.resume:
        final = app.invoke(
            Command(resume={"approved": args.approve, "by": args.by}), config
        )
    else:
        final = app.invoke(
            {"repo_name": args.repo, "run_id": args.run}, config
        )

    # An interrupted run comes back with __interrupt__ set — that is the signal
    # the graph paused, not that anything failed.
    if final.get("__interrupt__"):
        print(f"held — resume with: python graph.py --resume {thread} --approve")
    elif final.get("pr_url"):
        print(f"opened {final['pr_url']}")
    else:
        print(f"{final.get('verdict')}: {final.get('reason')}")


if __name__ == "__main__":
    main()
