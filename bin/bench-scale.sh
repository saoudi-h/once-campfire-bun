#!/usr/bin/env bash
# CPU/RAM scaling study: Bun vs Rust from 1 to 8 server threads.
# For each level: fresh seed, boot, idle memory, then room/messages/post
# throughput + peak memory. Load generator stays on 12-15 throughout.
#
#   bin/bench-scale.sh [--levels "8 8-9 8-11 4-11"] [--out DIR] [--secs 5]
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUST_ROOT=${RUST_ROOT:-$(cd "$HERE/../once-campfire-rust" && pwd)}
BUN_IMAGE=${BUN_IMAGE:-campfire-bun:bench}
RUST_IMAGE=${RUST_IMAGE:-campfire-rust:app}
LOADGEN_CPUS=${LOADGEN_CPUS:-12-15}
SECS=${SECS:-5}
LEVELS=${LEVELS:-"8 8-9 8-11 4-11"}
PORT=${PORT:-4390}
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --levels) LEVELS=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --secs) SECS=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
OUT=${OUT:-$HERE/bench/results/scale-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"
WORK=/tmp/bun-bench-scale
CONTAINER=bench-scale-$PORT
BASE=http://127.0.0.1:$PORT
SEED=$RUST_ROOT/parity/.seed/default
ENV_FILE=$RUST_ROOT/parity/.env.reference
LOADGEN=$RUST_ROOT/target/bench/release/loadgen

log() { echo "[$(date +%T)] $*" >&2; }
teardown() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap teardown EXIT INT TERM

(cd "$RUST_ROOT/bench/loadgen" && CARGO_TARGET_DIR=$RUST_ROOT/target/bench cargo build --release -q)
label() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$SEED/labels.json" "$1"; }
ROOM=$(label rooms.watercooler)
WRITE_ROOM=$(label rooms.hq)
BEFORE=$(label messages.busy_060)
EMAIL=$(label emails.david)
PASSWORD=$(label passwords.all)
lg() { taskset -c "$LOADGEN_CPUS" "$LOADGEN" "$@"; }
MB() { echo $(( $1 / 1048576 )); }

cgroup() { echo "/sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' "$CONTAINER").scope"; }
mem_now() { local cg; cg=$(cgroup); echo "$(cat "$cg/memory.current" 2>/dev/null || echo 0)"; }

start_app() {
  local app=$1 cpus=$2 dir=$WORK/$app
  local ncpu; ncpu=$(taskset -c "$cpus" nproc)
  local workers=$(( (ncpu * 666 + 999) / 1000 ))
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
  local args=()
  while IFS= read -r line; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    [[ "$line" =~ ^(WEB_CONCURRENCY|JOB_CONCURRENCY|RAILS_MAX_THREADS|RAILS_LOG_LEVEL)= ]] && continue
    args+=(-e "$line")
  done < "$ENV_FILE"
  if [ "$app" = rust ]; then
    docker run -d --name "$CONTAINER" --cpuset-cpus "$cpus" --user "$(id -u):$(id -g)" \
      --network host -e "HTTP_PORT=$PORT" -e "TARGET_PORT=$((PORT + 1))" \
      -e WEB_CONCURRENCY=$workers -e JOB_CONCURRENCY=$workers -e RAILS_MAX_THREADS=5 -e RAILS_LOG_LEVEL=warn \
      "${args[@]}" -v "$dir/db:/rails/storage/db" -v "$dir/storage:/rails/storage/files" \
      "$RUST_IMAGE" >/dev/null
  else
    docker run -d --name "$CONTAINER" --cpuset-cpus "$cpus" --user "$(id -u):$(id -g)" \
      --network host -e "HTTP_PORT=$PORT" -e "WEB_WORKERS=$workers" \
      "${args[@]}" -e "CAMPFIRE_STORAGE_PATH=/rails/storage" -e "NODE_ENV=production" \
      -v "$dir/db:/rails/storage/db" -v "$dir/storage:/rails/storage/files" \
      "$BUN_IMAGE" >/dev/null
  fi
  for _ in $(seq 1 3000); do
    if curl -fsS -o /dev/null "$BASE/up" 2>/dev/null; then break; fi
    sleep 0.02
  done
  curl -fsS -o /dev/null "$BASE/up" || { docker logs "$CONTAINER" | tail -20 >&2; return 1; }
  echo "$workers"
}

{
  echo "date: $(date -Is)"
  echo "host: $(uname -r), $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), $(nproc) threads"
  echo "loadgen cpus: $LOADGEN_CPUS; network: host; secs: $SECS"
  echo "bun image: $BUN_IMAGE $(docker image inspect -f '{{.Id}} {{.Created}}' "$BUN_IMAGE")"
  echo "rust image: $RUST_IMAGE $(docker image inspect -f '{{.Id}} {{.Created}}' "$RUST_IMAGE")"
  echo "bun HEAD: $(git -C "$HERE" rev-parse --short HEAD) (dirty: $(git -C "$HERE" status --porcelain | wc -l) files)"
} > "$OUT/env.txt"
cat "$OUT/env.txt" >&2
echo "app,cpus,threads,workers,idle_mb,room_rps,messages_rps,post_rps,peak_mb" > "$OUT/scale.csv"

idx=0
for cpus in $LEVELS; do
  idx=$((idx + 1))
  ncpu=$(taskset -c "$cpus" nproc)
  # Alternate app order per level against host drift.
  if [ $((idx % 2)) -eq 1 ]; then order="bun rust"; else order="rust bun"; fi
  for app in $order; do
    log "$app @ $cpus (${ncpu}t): starting"
    workers=$(start_app "$app" "$cpus")
    sleep 5
    idle=$(MB "$(mem_now)")
    cookie=$(lg login --base "$BASE" --email "$EMAIL" --password "$PASSWORD" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cookie"])')
    scrape=$(lg scrape --base "$BASE" --cookie "$cookie" --room "$ROOM")
    csrf=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["csrf"] or "")' "$scrape")
    room=$(lg http --base "$BASE" --cookie "$cookie" --path "/rooms/$ROOM" --conc 8 --duration "$SECS" | python3 -c 'import json,sys; print(round(json.load(sys.stdin)["rps"],1))')
    msgs=$(lg http --base "$BASE" --cookie "$cookie" --path "/rooms/$ROOM/messages?before=$BEFORE" --conc 8 --duration "$SECS" | python3 -c 'import json,sys; print(round(json.load(sys.stdin)["rps"],1))')
    post=$(lg http --base "$BASE" --cookie "$cookie" --post-room "$WRITE_ROOM" --csrf "$csrf" --conc 8 --duration "$SECS" | python3 -c 'import json,sys; print(round(json.load(sys.stdin)["rps"],1))')
    cg=$(cgroup)
    peak=$(MB "$(cat "$cg/memory.peak" 2>/dev/null || cat "$cg/memory.current")")
    echo "$app,$cpus,$ncpu,$workers,$idle,$room,$msgs,$post,$peak" | tee -a "$OUT/scale.csv"
    docker rm -f "$CONTAINER" >/dev/null
  done
done
log "results in $OUT/scale.csv"
