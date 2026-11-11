#!/usr/bin/env bash
# wanqi server 生命周期单入口(设计:docs/server-lifecycle.md v1,2026-11-11)
# 组件:db(3306) → server(7610) / test(7620);engine(7611)=DSH 侧外部组件,只观察不管理(2026-11-12 移出)
# 用法:
#   lifecycle.sh status [--json]
#   lifecycle.sh doctor                # 检查 + 按依赖序自动修复;exit 0=全绿(engine 只观察)
#   lifecycle.sh start|stop|restart [db|server|test|all]
#   lifecycle.sh logs <db|server|engine|test> [-n N] [-f]  # logs 仍可看 engine
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

# ---------- engine(7611):外部组件,2026-11-12 移出管理 ----------
# engine(dsh web)属 DSH 侧服务,万器不再启停/修复(双 dsh web 实例曾致调度任务双投递)。
# 健康观察见 status/doctor;启停归 DSH 侧:~/dsh/apphub/engine-supervisor.sh(+engine.stop 开关)。

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
  eng_ok && h=✓ || h=✗; echo "engine health=$h mode=$(mode_of app.dsh.apphub.engine engine-supervisor.sh) [外部:DSH 侧]"
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
    "engine": {"health": port_up(7611), "mode": mode("app.dsh.apphub.engine", "engine-supervisor.sh"), "external": True},
    "test":   {"health": tst(), "mode": mode("app.dsh.wanqi-test.server", "start-wanqi-test-server.sh")},
}, ensure_ascii=False))
PY
}

doctor() {
  local fail=0
  start_db    || fail=1
  start_server|| fail=1
  start_test  || fail=1
  # engine 自 2026-11-12 移出管理:只观察,不计入退出码,不自动拉起
  eng_ok && log "engine: 外部组件(DSH 侧)健康 ✓" \
          || log "engine: 外部组件(DSH 侧)不在(AI 网关 AI 端点将 503;万器不管理、不拉起)"
  if [ "$fail" = 0 ]; then log "SERVICE_OK"; else log "仍有组件不健康(见上)"; fi
  return $fail
}

# ---------- install / uninstall(一次性注册到 launchd) ----------
PLIST_DIR="$HOME/Library/LaunchAgents"
install_services() {
  # 接管语义:先清手动态进程,避免 launchd 实例与 nohup 实例抢端口
  stop_ordered all >/dev/null 2>&1 || true
  local rc=0
  for lbl in app.dsh.apphub.server app.dsh.wanqi-test.server; do  # engine 已移出(2026-11-12)
    local plist="$PLIST_DIR/$lbl.plist"
    if [ ! -f "$plist" ]; then
      log "install: ✗ $plist 缺失,该组件跳过"; rc=1; continue
    fi
    launchctl bootstrap "gui/$UID_N" "$plist" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/$UID_N/$lbl" >/dev/null 2>&1 || true
    if launchctl print "gui/$UID_N/$lbl" >/dev/null 2>&1; then
      log "install: $lbl ✓(launchd 托管)"
    else
      log "install: $lbl ✗ 当前会话域无权操作 launchd——请在你自己的 Terminal 里重跑: wanqi service install"
      rc=1
    fi
  done
  if [ "$rc" = 0 ]; then
    log "install: 全部注册完成"
  else
    log "install: 部分失败,回退为手动运行态(服务不中断)"
    ensure_ordered all >/dev/null 2>&1 || true
  fi
  return $rc
}
uninstall_services() {
  local rc=0
  for lbl in app.dsh.wanqi-test.server app.dsh.apphub.server; do  # engine 已移出(2026-11-12)
    launchctl bootout "gui/$UID_N/$lbl" >/dev/null 2>&1 || true
    if launchctl print "gui/$UID_N/$lbl" >/dev/null 2>&1; then
      log "uninstall: $lbl 仍在(域受限,请在用户 Terminal 重跑)"; rc=1
    else
      log "uninstall: $lbl 已卸出"
    fi
  done
  "$BREW" services stop mariadb >/dev/null 2>&1 || true
  log "uninstall: MariaDB brew 注册已停(数据保留);手动拉起态进程未动"
  return $rc
}

# ---------- run(前台调试) ----------
run_fg() {
  case "${1:-server}" in
    server)
      db_up || { log "run: DB(3306) 未起,先 wanqi service start db"; return 1; }
      cd "$HOME/Code/wanqi/server" || return 1
      export PUB_CACHE="$HOME/Code/wanqi/.pub-cache"
      exec "$HOME/dev/flutter/bin/cache/dart-sdk/bin/dart" run bin/apphub.dart --config "$APPDIR/config.json"
      ;;
    *) log "run: 仅支持 server(engine 属 DSH 侧,已移出管理)"; return 2 ;;
  esac
}

# ---------- 分发 ----------
ensure_ordered() { # start/restart 的组件=all 时按依赖序
  case "${1:-all}" in
    all)    start_db && start_server && start_test ;;
    db)     start_db ;;
    server) start_db >/dev/null 2>&1; start_server ;;
    engine) log "engine 属 DSH 侧服务,2026-11-12 起万器不再管理;启停见 ~/dsh/apphub/engine-supervisor.sh"; return 2 ;;
    test)   start_db >/dev/null 2>&1; start_test ;;
    *) log "未知组件: $1 (db|server|test|all)"; return 2 ;;
  esac
}
stop_ordered() {
  case "${1:-all}" in
    all)    stop_test; stop_server; stop_db ;;
    db)     stop_db ;;
    server) stop_server ;;
    engine) log "engine 属 DSH 侧服务,2026-11-12 起万器不再管理"; return 2 ;;
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
  ensure)
    lock; doctor; exit $? ;;
  install)
    lock; install_services; exit $? ;;
  uninstall)
    lock; uninstall_services; exit $? ;;
  run)
    run_fg "$@"; exit $? ;;
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
