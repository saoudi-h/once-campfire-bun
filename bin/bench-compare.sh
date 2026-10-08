#!/usr/bin/env bash
# Interleaved Bun-vs-Rust benchmark for publishable numbers.
# Mirrors once-campfire-rust/bench/run essentials: fresh seed per run,
# pinned CPUs, host networking, warmup then measure, alternating order.
#
#   bin/bench-compare.sh [--apps bun,rust] [--reps 3] [--out DIR]
#                        [--suites http,cable] [--concs "1 16"]
#                        [--rep-from N] [--rep-to M]   (resume a range)
#   Env: RUST_ROOT (sibling checkout, default ../once-campfire-rust),
#        BUN_IMAGE, RUST_IMAGE, SERVER_CPUS=8-11, LOADGEN_CPUS=12-15,
#        HTTP_SECS=8, CABLE_CLIENTS="100", CABLE_TPUT_SECS=10, PORT=4390
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUST_ROOT=${RUST_ROOT:-$(cd "$HERE/../once-campfire-rust" && pwd)}
BUN_IMAGE=${BUN_IMAGE:-campfire-bun:bench}
RUST_IMAGE=${RUST_IMAGE:-campfire-rust:app}
SERVER_CPUS=${SERVER_CPUS:-8-11}
LOADGEN_CPUS=${LOADGEN_CPUS:-12-15}
HTTP_SECS=${HTTP_SECS:-8}
CONCS=${CONCS:-1 16}
CABLE_CLIENTS=${CABLE_CLIENTS:-100}
CABLE_TPUT_SECS=${CABLE_TPUT_SECS:-10}
CABLE_POSTERS=${CABLE_POSTERS:-4}
PORT=${PORT:-4390}
SUITES=${SUITES:-http,cable}
APPS=bun,rust REPS=3 OUT="" REP_FROM=1 REP_TO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apps) APPS=$2; shift 2 ;;
    --reps) REPS=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --suites) SUITES=$2; shift 2 ;;
    --concs) CONCS=$2; shift 2 ;;
    --rep-from) REP_FROM=$2; shift 2 ;;
    --rep-to) REP_TO=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
suite() { [[ ",$SUITES," = *",$1,"* ]]; }
OUT=${OUT:-$HERE/bench/results/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"
WORK=/tmp/bun-bench-compare
CONTAINER=bench-compare-$PORT
BASE=http://127.0.0.1:$PORT
SEED=$RUST_ROOT/parity/.seed/default
ENV_FILE=$RUST_ROOT/parity/.env.reference
LOADGEN=$RUST_ROOT/target/bench/release/loadgen

log() { echo "[$(date +%T)] $*" >&2; }
teardown() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap teardown EXIT INT TERM

# Build the load generator like bench/run does.
(cd "$RUST_ROOT/bench/loadgen" && CARGO_TARGET_DIR=$RUST_ROOT/target/bench cargo build --release -q)
[ -x "$LOADGEN" ] || { echo "loadgen missing" >&2; exit 1; }

label() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$SEED/labels.json" "$1"; }
ROOM=$(label rooms.watercooler)
WRITE_ROOM=$(label rooms.hq)
BEFORE=$(label messages.busy_060)
AVATAR=$(label avatar_tokens.jason)
EMAIL=$(label emails.david)
PASSWORD=$(label passwords.all)
lg() { taskset -c "$LOADGEN_CPUS" "$LOADGEN" "$@"; }

start_app() {
  local app=$1 dir=$WORK/$app
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$dir"; mkdir -p "$dir/db" "$dir/storage"
  cp -a --reflink=auto "$SEED/db/production.sqlite3" "$dir/db/" 2>/dev/null || cp -a "$SEED/db/production.sqlite3" "$dir/db/"
  cp -a --reflink=auto "$SEED/storage/." "$dir/storage/"
  python3 - "$dir/db/production.sqlite3" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("UPDATE push_subscriptions SET endpoint = 'https://127.0.0.1:9/push/' || id")
db.execute("UPDATE webhooks SET url = 'http://127.0.0.1:9/hook/' || id")
db.commit()
PY
  # Base env from the parity env file (test-only keys), minus the
  # reference process model which is set per app below.
  local args=()
  while IFS= read -r line; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    [[ "$line" =~ ^(WEB_CONCURRENCY|JOB_CONCURRENCY|RAILS_MAX_THREADS|RAILS_LOG_LEVEL)= ]] && continue
    args+=(-e "$line")
  done < "$ENV_FILE"
  if [ "$app" = rust ]; then
    docker run -d --name "$CONTAINER" --cpuset-cpus "$SERVER_CPUS" --user "$(id -u):$(id -g)" \
      --network host -e "HTTP_PORT=$PORT" -e "TARGET_PORT=$((PORT + 1))" \
      -e WEB_CONCURRENCY=3 -e JOB_CONCURRENCY=3 -e RAILS_MAX_THREADS=5 -e RAILS_LOG_LEVEL=warn \
      "${args[@]}" -v "$dir/db:/rails/storage/db" -v "$dir/storage:/rails/storage/files" \
      "$RUST_IMAGE" >/dev/null
  else
    docker run -d --name "$CONTAINER" --cpuset-cpus "$SERVER_CPUS" --user "$(id -u):$(id -g)" \
      --network host -e "HTTP_PORT=$PORT" -e "WEB_WORKERS=4" \
      "${args[@]}" -e "CAMPFIRE_STORAGE_PATH=/rails/storage" -e "NODE_ENV=production" \
      -v "$dir/db:/rails/storage/db" -v "$dir/storage:/rails/storage/files" \
      "$BUN_IMAGE" >/dev/null
  fi
  for _ in $(seq 1 3000); do
    if curl -fsS -o /dev/null "$BASE/up" 2>/dev/null; then break; fi
    sleep 0.02
  done
  curl -fsS -o /dev/null "$BASE/up" || { docker logs "$CONTAINER" | tail -20 >&2; return 1; }
}

{
  echo "date: $(date -Is)"
  echo "host: $(uname -r), $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), $(nproc) threads"
  echo "server cpus: $SERVER_CPUS; loadgen cpus: $LOADGEN_CPUS; network: host"
  echo "bun image: $BUN_IMAGE $(docker image inspect -f '{{.Id}} {{.Created}}' "$BUN_IMAGE")"
  echo "rust image: $RUST_IMAGE $(docker image inspect -f '{{.Id}} {{.Created}}' "$RUST_IMAGE")"
  echo "bun HEAD: $(git -C "$HERE" rev-parse --short HEAD) (dirty: $(git -C "$HERE" status --porcelain | wc -l) files)"
  echo "rust HEAD: $(git -C "$RUST_ROOT" rev-parse --short HEAD 2>/dev/null || echo n/a)"
} > "$OUT/env.txt"
cat "$OUT/env.txt" >&2

ORDER=(${APPS//,/ })
run_rep() {
  local app=$1 rep=$2 f=$OUT/$app-$rep.json
  log "$app rep $rep: starting"
  start_app "$app"
  local cookie scrape csrf streams css
  cookie=$(lg login --base "$BASE" --email "$EMAIL" --password "$PASSWORD" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cookie"])')
  scrape=$(lg scrape --base "$BASE" --cookie "$cookie" --room "$ROOM")
  csrf=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["csrf"] or "")' "$scrape")
  streams=$(python3 -c 'import json,sys; print(",".join(json.loads(sys.argv[1])["streams"]))' "$scrape")
  css=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["css"])' "$scrape")
  local http_json="[]" cable_json="[]"
  if suite http; then
    local routes=(
      "room_show|/rooms/$ROOM"
      "messages_page|/rooms/$ROOM/messages?before=$BEFORE"
      "sidebar|/users/me/sidebar"
      "search|/searches?q=coffee"
      "avatar|/users/$AVATAR/avatar"
      "static_css|$css"
      "up|/up"
      "post_message|POST"
    )
    local r name path args
    for r in "${routes[@]}"; do
      name=${r%%|*}; path=${r#*|}
      if [ "$path" = POST ]; then args=(--post-room "$WRITE_ROOM" --csrf "$csrf"); else args=(--path "$path"); fi
      lg http --base "$BASE" --cookie "$cookie" "${args[@]}" --conc 4 --duration 2 >/dev/null
      for c in $CONCS; do
        local res dur=8; [ "$c" = 1 ] && dur=5
        res=$(lg http --base "$BASE" --cookie "$cookie" "${args[@]}" --conc "$c" --duration "$dur")
        http_json=$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); r=json.loads(sys.argv[2]); r["route"]=sys.argv[3]; a.append(r); print(json.dumps(a))' "$http_json" "$res" "$name")
        log "$app rep $rep: $name c=$c $(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); print(r["rps"], "rps p50", r["latency"].get("p50_ms"), "p99", r["latency"].get("p99_ms"), r["statuses"], "err", r["errors"])' "$res")"
      done
    done
  fi
  if suite cable; then
    local n
    for n in $CABLE_CLIENTS; do
      local res
      res=$(lg cable --base "$BASE" --cookie "$cookie" --room "$ROOM" --csrf "$csrf" --streams "$streams" \
        --clients "$n" --tput-secs "$CABLE_TPUT_SECS" --posters "$CABLE_POSTERS" 2>/dev/null)
      cable_json=$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a.append(json.loads(sys.argv[2])); print(json.dumps(a))' "$cable_json" "$res")
      log "$app rep $rep: cable $n clients $(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); print("ready", r["ready"], "p50", r["latency"]["all_clients"].get("p50_ms"), "tput", r["throughput"]["delivered_msgs_per_sec"])' "$res")"
    done
  fi
  python3 - "$f" "$app" "$rep" "$http_json" "$cable_json" <<'PY'
import json, sys
f, app, rep, http, cable = sys.argv[1:]
json.dump({"app": app, "rep": int(rep), "http": json.loads(http), "cable": json.loads(cable)}, open(f, "w"), indent=1)
PY
  docker rm -f "$CONTAINER" >/dev/null
  log "$app rep $rep: done -> $f"
}

for rep in $(seq 1 "$REPS"); do
  if [ -n "$REP_FROM" ] && [ "$rep" -lt "$REP_FROM" ]; then continue; fi
  if [ -n "$REP_TO" ] && [ "$rep" -gt "$REP_TO" ]; then continue; fi
  apps=("${ORDER[@]}")
  if [ $((rep % 2)) -eq 0 ]; then apps=(); for ((i = ${#ORDER[@]} - 1; i >= 0; i--)); do apps+=("${ORDER[$i]}"); done; fi
  for app in "${apps[@]}"; do run_rep "$app" "$rep"; done
done
log "results in $OUT"
