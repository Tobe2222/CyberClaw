#!/usr/bin/env python3
"""Watch OpenClaw agent databases for tool calls (read-only).

OpenClaw >= 2026.9 keeps transcripts in ~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite
instead of JSONL files. This polls each agent's transcript_events table and prints one JSON
line per tool call: {"agent": id, "tool": name, "args": {...short...}, "ts": ms}.
Usage: openclaw-tool-watch.py <agentId>=<sqlitePath> [...]
"""
import json, sqlite3, sys, time

def short(v, n=160):
    s = v if isinstance(v, str) else json.dumps(v)
    return s if len(s) <= n else s[:n - 1] + "…"

def main():
    dbs = {}
    for a in sys.argv[1:]:
        aid, _, p = a.partition("=")
        dbs[aid] = {"path": p, "last": None, "conn": None}
    while True:
        for aid, d in dbs.items():
            try:
                if d["conn"] is None:
                    d["conn"] = sqlite3.connect("file:%s?mode=ro" % d["path"], uri=True, timeout=1)
                c = d["conn"]
                if d["last"] is None:
                    d["last"] = c.execute("select coalesce(max(created_at),0) from transcript_events").fetchone()[0]
                    continue
                rows = c.execute("select created_at, event_json from transcript_events where created_at > ? and event_json is not null order by created_at limit 200", (d["last"],)).fetchall()
                for ts, ej in rows:
                    d["last"] = max(d["last"], ts)
                    try: ev = json.loads(ej)
                    except Exception: continue
                    msg = ev.get("message") or {}
                    if msg.get("role") != "assistant": continue
                    parts = msg.get("content") or []
                    if any(isinstance(p, dict) and p.get("type") == "text" and str(p.get("text", "")).strip() for p in parts):
                        print(json.dumps({"agent": aid, "tool": "__text__", "args": {}, "ts": ts}), flush=True)
                    for part in parts:
                        if isinstance(part, dict) and part.get("type") in ("toolCall", "tool_use"):
                            args = part.get("arguments") or part.get("input") or {}
                            keep = {k: short(args[k]) for k in ("title", "command", "path", "file_path", "query", "url", "action", "pattern") if isinstance(args, dict) and k in args}
                            print(json.dumps({"agent": aid, "tool": part.get("name"), "args": keep, "ts": ts}), flush=True)
            except sqlite3.Error:
                try:
                    if d["conn"]: d["conn"].close()
                except Exception: pass
                d["conn"] = None
        time.sleep(0.7)

if __name__ == "__main__":
    main()
