#!/usr/bin/env python3
"""Summarize a bench-compare.sh results dir: median [min-max] per app.

Usage: bin/bench-report.py bench/results/<stamp> > report.md
"Adv" is Bun vs Rust from the medians (>1 means Bun is better).
"""
import glob
import json
import os
import statistics
import sys

out = sys.argv[1]
runs: dict[str, list] = {}
for f in sorted(glob.glob(os.path.join(out, "bun-*.json")) + glob.glob(os.path.join(out, "rust-*.json"))):
    r = json.load(open(f))
    runs.setdefault(r["app"], []).append(r)
apps = [a for a in ("bun", "rust") if a in runs]


def cell(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return None, "-"
    m = statistics.median(vals)
    fmt = (lambda v: f"{v:,.0f}") if m >= 100 else (lambda v: f"{v:.1f}")
    spread = f" [{fmt(min(vals))}-{fmt(max(vals))}]" if len(vals) > 1 else ""
    return m, fmt(m) + spread


def row(name, getter, higher_better):
    meds, cells = {}, []
    for a in apps:
        vals = []
        for r in runs[a]:
            try:
                vals.append(getter(r))
            except (KeyError, IndexError, TypeError, StopIteration):
                vals.append(None)
        m, c = cell(vals)
        meds[a] = m
        cells.append(c)
    ratio = "-"
    if len(apps) == 2 and meds.get("bun") and meds.get("rust"):
        x = meds["bun"] / meds["rust"] if higher_better else meds["rust"] / meds["bun"]
        ratio = f"{x:.2f}x"
    print(f"| {name} | " + " | ".join(cells) + f" | {ratio} |")


def header(title):
    print(f"\n### {title}\n")
    print("| Metric | " + " | ".join("Bun" if a == "bun" else "Rust" for a in apps) + " | Bun adv. |")
    print("|---|" + "---|" * len(apps) + "---|")


env = os.path.join(out, "env.txt")
if os.path.exists(env):
    print("```\n" + open(env).read().strip() + "\n```")
print(f"\nReps: " + ", ".join(f"{a} {len(runs[a])}" for a in apps) + ". Cells: median [min-max].")

first = runs[apps[0]][0]
routes = []
for h in first["http"]:
    if (h["route"], h["conc"]) not in routes:
        routes.append((h["route"], h["conc"]))


def http(route, conc, key):
    def get(r):
        h = next(h for h in r["http"] if h["route"] == route and h["conc"] == conc)
        if h["latency"].get("n", 0) == 0 or h["ok"] == 0:
            return None
        return h["rps"] if key == "rps" else h["latency"][key]
    return get


header("HTTP (c = concurrent connections)")
for route, conc in routes:
    row(f"{route} c={conc} req/s", http(route, conc, "rps"), True)
for route, conc in routes:
    if conc == 1:
        row(f"{route} c=1 p50 ms", http(route, conc, "p50_ms"), False)
for route, conc in routes:
    if conc == 16:
        row(f"{route} c=16 p99 ms", http(route, conc, "p99_ms"), False)

print("\n### HTTP errors / non-2xx (first rep, per app)\n")
for a in apps:
    bad = [f"{h['route']} c={h['conc']}: {h['statuses']} errors={h['errors']}" for h in runs[a][0]["http"]
           if h["errors"] or any(int(k) >= 400 for k in h["statuses"])]
    print(f"- {a}: " + ("; ".join(bad) if bad else "none"))

if first["cable"]:
    header("Action Cable fan-out")
    for i, c in enumerate(first["cable"]):
        n = c["clients"]
        row(f"{n} clients: subscribed", lambda r, i=i: r["cable"][i]["ready"], True)
        row(f"{n} clients: paced post->all p50 ms", lambda r, i=i: r["cable"][i]["latency"]["all_clients"]["p50_ms"], False)
        row(f"{n} clients: paced post->all p99 ms", lambda r, i=i: r["cable"][i]["latency"]["all_clients"]["p99_ms"], False)
        row(f"{n} clients: msgs/s delivered to all", lambda r, i=i: r["cable"][i]["throughput"]["delivered_msgs_per_sec"], True)
        row(f"{n} clients: frames/s", lambda r, i=i: r["cable"][i]["throughput"]["frames_per_sec"], True)
