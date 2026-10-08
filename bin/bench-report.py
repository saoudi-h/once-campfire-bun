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
merged: dict[tuple, dict] = {}
for f in sorted(glob.glob(os.path.join(out, "bun-*.json")) + glob.glob(os.path.join(out, "rust-*.json"))):
    r = json.load(open(f))
    key = (r["app"], r["rep"])
    m = merged.setdefault(key, {"app": r["app"], "rep": r["rep"], "http": [], "cablelevels": {}, "upload": {}})
    base = os.path.basename(f)
    legacy = "-http" not in base and "-cable" not in base and "-upload" not in base
    # Per-suite files (app-N-http.json, app-N-cable-100.json) contribute
    # their suite; legacy files (app-N.json) contribute whatever is set.
    # Cable levels merge by client count so 100/500/1000 runs coexist.
    if (base.endswith("-http.json") or legacy) and r.get("http"):
        m["http"] = r["http"]
    if ("-cable" in base or legacy) and r.get("cable"):
        for c in r["cable"]:
            m["cablelevels"][c["clients"]] = c
    if ("-upload" in base or legacy) and r.get("upload"):
        m["upload"] = r["upload"]
runs: dict[str, list] = {}
for m in merged.values():
    runs.setdefault(m["app"], []).append(m)
for a in runs:
    runs[a].sort(key=lambda r: r["rep"])
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

def cable_at(n, key):
    def get(r):
        c = r["cablelevels"].get(n)
        if not c:
            return None
        try:
            if key == "ready":
                return c["ready"]
            if key == "tput":
                return c["throughput"]["delivered_msgs_per_sec"]
            if key == "frames":
                return c["throughput"]["frames_per_sec"]
            return c["latency"]["all_clients"][key]
        except (KeyError, IndexError, TypeError):
            return None
    return get


levels = sorted({n for a in apps for r in runs[a] for n in r["cablelevels"]})
if levels:
    header("Action Cable fan-out")
    for n in levels:
        row(f"{n} clients: subscribed", cable_at(n, "ready"), True)
        row(f"{n} clients: paced post->all p50 ms", cable_at(n, "p50_ms"), False)
        row(f"{n} clients: paced post->all p99 ms", cable_at(n, "p99_ms"), False)
        row(f"{n} clients: msgs/s delivered to all", cable_at(n, "tput"), True)
        row(f"{n} clients: frames/s", cable_at(n, "frames"), True)

def _umed(key):
    def get(r):
        vals = sorted(x[key] for x in r["upload"].get("runs", []) if key in x and isinstance(x[key], (int, float)))
        return vals[len(vals) // 2] if vals else None
    return get


if any(r.get("upload") for a in apps for r in runs[a]):
    header("Upload + thumbnail (black_hole.jpg, 505 KB)")
    row("POST with attachment median ms", _umed("post_ms"), False)
    row("then GET thumb median ms", _umed("thumb_ms"), False)
    row("POST -> thumbnail served median ms", lambda r: r["upload"].get("median_total_ms"), False)
