#!/usr/bin/env bash
# wanqi server 生命周期单入口(设计:docs/server-lifecycle.md v1,2026-11-11)
# 组件:db(3306) → server(7610) / engine(7611) / test(7620)
# 用法:
#   lifecycle.sh status [--json]
#   lifecycle.sh doctor                # 检查 + 按依赖序自动修复;exit 0=全绿
#   lifecycle.sh start|stop|restart [db|server|engine|test|all]
#   lifecycle.sh logs <db|server|engine|test> [-n N] [-f]
# 幂等;launchctl 域不可见时自动降级 nohup,绝不因此失败。
set -u

APPDIR="$HOME/dsh/apphub"
TESTDIR="$HOME/dsh/wanqi-test"
LOGD="$APPDIR"
LOCK=/tmp/wanqi-lifecycle.lock
MARIA_DBD=/opt/homebrew/opt/mariadb/bin/mariadbd
MARIA_CLI=/opt/homebrew/opt/mariadb/bin/mariadb
BREW=/opt/homebrew/bin/brew
UID_N=$(id -u)

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$1" 2>/dev/null || echo 000; }
db_up()   { port_up 3306; }
srv_ok()  { [ "$(http_code http://127.0.0.1:7610/api/v1/apps)" = "200" ]; }
eng_ok()  { port_up 7611; }
tst_ok()  { [ "$(http_code http://127.0.0.1:7620/api/v1/apps)" = "200" ]; }
log() { echo "[lifecycle] $*"; }
lock() { mkdir "$LOCK" 2>/dev/null || { log "另一个 lifecycle 正在执行($LOCK)"; exit 9; }; trap 'rmdir "$LOCK" 2>/dev/null' EXIT; }

# ---------- db ----------
start_db() {
  db_up && { log "db: 3306 已在,跳过"; return 0; }
  log "db: 3306 不在,先试 brew services…"
  "$BREW" services start mariadb >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do sleep 2; db_up && { log "db: brew services 拉起 ✓"; return 0; }; done
  log "db: brew 不可用(域限制),直接 mariadbd…"
  nohup "$MARIA_DBD" --datadir=/opt/homebrew/var/mysql --port=3306 --bind-address=127.0.0.1 >> "$LOGD/mariadb.log" 2>&1 &
  for _ in $(seq 1 10); do sleep 3; db_up && { log "db: mariadbd 手动拉起 ✓"; return 0; }; done
  log "db: ✗ 起不来,看 $LOGD/mariadb.log"; return 1
}
stop_db() {
  "$BREW" services stop mariadb >/dev/null 2>&1 || true
  sleep 2; port_up 3306 || { log "db: 已停"; return 0; }
  pkill -f 'mariadbd.*port=3306' 2>/dev/null || true
  sleep 2; port_up 3306 && { log "db: ✗ 3306 仍占用"; return 1; }
  log "db: 已停"; return 0
}

# ---------- server(生产 7610) ----------
start_server() {
  srv_ok && { log "server: 7610 健康,跳过"; return 0; }
  launchctl kickstart -k "gui/$UID_N/app.dsh.apphub.server" >/dev/null 2>&1 || true
  for _ in 1 2 3; do sleep 4; srv_ok && { log "server: launchd 拉起 ✓"; return 0; }; done
  log "server: launchd 不可达,降级 nohup…"
  nohup /bin/bash "$APPDIR/start-apphub-server.sh" >> "$LOGD/apphub-server.log" 2>&1 &
  for _ in $(seq 1 10); do sleep 3; srv_ok && { log "server: nohup 拉起 ✓"; return 0; }; done
  log "server: ✗ 起不来,看 $LOGD/apphub-server.log"; return 1
}
stop_server() {
  pids=$(lsof -nP -t -iTCP:7610 -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] && { kill $pids 2>/dev/null; sleep 2; }
  pids=$(lsof -nP -t -iTCP:7610 -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] && { kill -9 $pids 2>/dev/null; sleep 1; }
  port_up 7610 && { log "server: 7610 仍占用(launchd KeepAlive 会拉回,属预期)"; return 0; }
  log "server: 已停(launchd 托管态会被拉回,属预期)"; return 0
}

# ---------- engine(7611) ----------
start_engine() {
  eng_ok && { log "engine: 7611 已在,跳过"; return 0; }
  launchctl kickstart -k "gui/$UID_N/app.dsh.apphub.engine" >/dev/null 2>&1 || true
  for _ in 1 2 3; do sleep 4; eng_ok && { log "engine: launchd 拉起 ✓"; return 0; }; done
  log "engine: 降级 nohup…"
  nohup /bin/bash "$APPDIR/engine-supervisor.sh" >> "$LOGD/engine-supervisor.log" 2>&1 &
  for _ in $(seq 1 8); do sleep 3; eng_ok && { log "engine: nohup 拉起 ✓"; return 0; }; done
  log "engine: ✗ 起不来,看 $LOGD/engine-supervisor.log"; return 1
}
stop_engine() {
  pkill -f 'engine-supervisor.sh' 2>/dev/null || true
  sleep 1
  pids=$(lsof -nP -t -iTCP:7611 -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] && { kill $pids 2>/dev/null; sleep 2; }
  port_up 7611 && { log "engine: 7611 仍占用"; return 1; }
  log "engine: 已停(launchd 托管态会被拉回,属预期)"; return 0
}

# ---------- test(7620) ----------
start_test() {
  tst_ok && { log "test: 7620 健康,跳过"; return 0; }
  launchctl kickstart -k "gui/$UID_N/app.dsh.wanqi-test.server" >/dev/null 2>&1 || true
  for _ in 1 2 3; do sleep 4; tst_ok && { log "test: launchd 拉起 ✓"; return 0; }; done
  log "test: 降级 nohup…"
  nohup /bin/bash "$TESTDIR/start-wanqi-test-server.sh" >> "$TESTDIR/wanqi-test-server.log" 2>&1 &
  for _ in $(seq 1 10); do sleep 3; tst_ok && { log "test: nohup 拉起 ✓"; return 0; }; done
  log "test: ✗ 起不来,看 $TESTDIR/wanqi-test-server.log"; return 1
}
stop_test() {
  pids=$(lsof -nP -t -iTCP:7620 -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] && { kill $pids 2>/dev/null; sleep 2; }
  port_up 7620 && { log "test: 7620 仍占用"; return 1; }
  log "test: 已停"; return 0
}

# ---------- 托管形态 ----------
mode_of() { # $1=launchd label  $2=进程特征
  if launchctl print "gui/$UID_N/$1" >/dev/null 2>&1; then echo launchd; return; fi
  if pgrep -f "$2" >/dev/null 2>&1; then echo nohup; return; fi
  echo "-"
}

status_plain() {
  local h
  db_up && h=✓ || h=✗; echo "db     health=$h mode=$(mode_of sh.brew.mariadb mariadbd)"
  srv_ok && h=✓ || h=✗; echo "server health=$h mode=$(mode_of app.dsh.apphub.server 'apphub\.dart|start-apphub-server\.sh')"
  eng_ok && h=✓ || h=✗; echo "engine health=$h mode=$(mode_of app.dsh.apphub.engine engine-supervisor.sh)"
  tst_ok && h=✓ || h=✗; echo "test   health=$h mode=$(mode_of app.dsh.wanqi-test.server start-wanqi-test-server.sh)"
}
status_json() {
  python3 - "$UID_N" <<'PY'
import json, subprocess, sys
uid = sys.argv[1]
def port_up(p):
    import socket
    s = socket.socket(); s.settimeout(2)
    try: s.connect(("127.0.0.1", p)); return True
    except Exception: return False
    finally: s.close()
def http(url):
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=4) as r: return r.status
    except Exception as e:
        return getattr(e, 'code', 0) or 0
def mode(label, pat):
    try:
        subprocess.run(["launchctl", "print", f"gui/{uid}/{label}"], capture_output=True, check=True)
        return "launchd"
    except subprocess.CalledProcessError: pass
    try:
        subprocess.run(["pgrep", "-f", pat], capture_output=True, check=True); return "nohup"
    except Exception: return "-"
def srv(): return http("http://127.0.0.1:7610/api/v1/apps") == 200
def tst(): return http("http://127.0.0.1:7620/api/v1/apps") == 200
print(json.dumps({
    "db":     {"health": port_up(3306), "mode": mode("sh.brew.mariadb", "mariadbd")},
    "server": {"health": srv(), "mode": mode("app.dsh.apphub.server", "start-apphub-server.sh")},
    "engine": {"health": port_up(7611), "mode": mode("app.dsh.apphub.engine", "engine-supervisor.sh")},
    "test":   {"health": tst(), "mode": mode("app.dsh.wanqi-test.server", "start-wanqi-test-server.sh")},
}, ensure_ascii=False))
PY
}

doctor() {
  local fail=0
  start_db    || fail=1
  start_server|| fail=1
  start_engine|| fail=1
  start_test  || fail=1
  if [ "$fail" = 0 ]; then log "SERVICE_OK"; else log "仍有组件不健康(见上)"; fi
  return $fail
}

# ---------- 分发 ----------
ensure_ordered() { # start/restart 的组件=all 时按依赖序
  case "${1:-all}" in
    all)    start_db && start_server && start_engine && start_test ;;
    db)     start_db ;;
    server) start_db >/dev/null 2>&1; start_server ;;
    engine) start_engine ;;
    test)   start_db >/dev/null 2>&1; start_test ;;
    *) log "未知组件: $1 (db|server|engine|test|all)"; return 2 ;;
  esac
}
stop_ordered() {
  case "${1:-all}" in
    all)    stop_test; stop_engine; stop_server; stop_db ;;
    db)     stop_db ;;
    server) stop_server ;;
    engine) stop_engine ;;
    test)   stop_test ;;
    *) log "未知组件: $1"; return 2 ;;
  esac
}

cmd=${1:-status}; shift 2>/dev/null || true
case "$cmd" in
  status)
    for a in "$@"; do [ "$a" = "--json" ] && { status_json; exit 0; }; done
    status_plain; exit 0 ;;
  doctor)
    lock; doctor; exit $? ;;
  start)
    lock; ensure_ordered "${1:-all}"; exit $? ;;
  stop)
    lock; stop_ordered "${1:-all}"; exit $? ;;
  restart)
    lock
    if [ "${1:-all}" = all ]; then stop_ordered all; ensure_ordered all; exit $?
    else stop_ordered "$1"; ensure_ordered "$1"; exit $?; fi ;;
  logs)
    comp=${1:?logs 需要组件名}; shift
    n=20; follow=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -n) n=$2; shift 2 ;;
        -f) follow=1; shift ;;
        *) shift ;;
      esac
    done
    case "$comp" in
      db)     f="$LOGD/mariadb.log"; [ -s "$f" ] || f=/tmp/mariadb-manual.log ;;
      server) f="$LOGD/apphub-server.log" ;;
      engine) f="$LOGD/engine-supervisor.log" ;;
      test)   f="$TESTDIR/wanqi-test-server.log" ;;
      *) log "未知组件: $comp"; exit 2 ;;
    esac
    if [ -n "$follow" ]; then tail -n "$n" -f "$f"; else tail -n "$n" "$f"; fi ;;
  *)
    sed -n '2,12p' "$0"; exit 2 ;;
esac
