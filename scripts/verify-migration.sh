#!/usr/bin/env bash
# 万器 Bundle 端到端迁移验证清单(task-3)。
# 对测试 server 逐包 install 12 个示例 zip,断言:市场列表/manifest/sha256/包下载/
# routes 干净/flappy 生命周期(upgrade→rollback→remove→install)/失败面三条拒收。
#
# 形态对齐 server 实现(task-1 定稿):
#   - CLI: cd server && dart run bin/wanqi.dart bundle <cmd> --server … --key <publisherKey>
#     四命令 bundle install <zip> / bundle upgrade <zip> / bundle rollback --app <id> / bundle remove --app <id>
#   - routes 查询: GET /api/v1/gateway/routes
#   - v1 install 不 spawn:routes target 为占位;market 行带 backend 布尔
#   - remove 清市场行+代码目录(data/logs/DB 保留)→ remove 后 install 同版本可行
#
# 用法(仓库根执行):bash scripts/verify-migration.sh
# 可覆盖变量:SERVER / WANQI / PUB_CACHE / ROUTES_API / PKG_BASE / MANIFEST_T / KEY
set -u
cd "$(dirname "$0")/.." || exit 2
ROOT="$(pwd)"
SERVER="${SERVER:-http://127.0.0.1:7620}"
DART="${DART:-/Users/weimingchen/dev/flutter/bin/cache/dart-sdk/bin/dart}"
PUB_CACHE="${PUB_CACHE:-$ROOT/.pub-cache}"
WANQI="${WANQI:-$DART run bin/wanqi.dart}"
ROUTES_API="${ROUTES_API:-/api/v1/gateway/routes}"
PKG_BASE="${PKG_BASE:-$SERVER/packages}"
MANIFEST_T="${MANIFEST_T:-$SERVER/apps/%s/manifest.json}"
KEY="${KEY:-$(python3 -c "import json;print(json.load(open('server/config.local.json'))['publisherKey'])")}"
DIST="$ROOT/examples/dist"
TMP="$(mktemp -d /tmp/wanqi-verify.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $*"; }
CLI_OUT="$TMP/cli-last.out"
run_cli() { (cd "$ROOT/server" && PUB_CACHE="$PUB_CACHE" $WANQI "$@" --server "$SERVER" --key "$KEY") >"$CLI_OUT" 2>&1 ; }
cli_show() { sed 's/^/  └─ CLI: /' "$CLI_OUT" | head -6; }
apps_json() { curl -sf "$SERVER/api/v1/apps"; }

# ---- 12 包清单:zip 文件名 appId code name entry backend(true/false)----
PKGS=(
  "wx5b8e2f4a9c1d7e60-10.zip wx5b8e2f4a9c1d7e60 10 game false"
  "wx2f8a4c6e1d3b5a79-14.zip wx2f8a4c6e1d3b5a79 14 pages/index/index false"
  "wx3d7b2f91c4a8e5d6-13.zip wx3d7b2f91c4a8e5d6 13 game false"
  "wx9d4e6a2c8b1f7e35-4.zip  wx9d4e6a2c8b1f7e35 4  pages/index/index false"
  "wx92269e3b2f304afc-73.zip wx92269e3b2f304afc 73 example/index false"
  "wx3d8b6f2a9c4e7d15-20.zip wx3d8b6f2a9c4e7d15 20 pages/home/home false"
  "wx8c4e2f6a9d1b7e53-10.zip wx8c4e2f6a9d1b7e53 10 game false"
  "darkmode-demo-3.zip       darkmode-demo      3  pages/index/index false"
  "wx8d31a5f0c94b27e6-8.zip  wx8d31a5f0c94b27e6 8  pages/index/index true"
  "wx7c3e9d2a1b4f5e68-4.zip  wx7c3e9d2a1b4f5e68 4  pages/list/list false"
  "wx5f8a2d7c9e1b4f30-2.zip  wx5f8a2d7c9e1b4f30 2  game false"
  "wx3a7f2c9e1b8d4f56-1.zip  wx3a7f2c9e1b8d4f56 1  pages/audio/audio false"
)
FLAPPY=wx5b8e2f4a9c1d7e60
SYSMON=wx8d31a5f0c94b27e6

echo "== 0. 前置:server 可达 + 发布产物完备 =="
apps_json >/dev/null && ok "server 可达 $SERVER" || { bad "server 不可达 $SERVER,先启动测试 server"; exit 1; }
zips=(); for row in "${PKGS[@]}"; do zips+=("${row%% *}"); done
python3 - "$DIST" "${zips[@]}" <<'EOF'
import sys, zipfile
dist, zips = sys.argv[1], sys.argv[2:]
for z in zips:
    with zipfile.ZipFile(f"{dist}/{z}") as f:
        names = f.namelist()
        assert "bundle.json" in names, f"{z}: zip 根缺 bundle.json"
        assert "main/app-config.json" in names, f"{z}: 缺 main/app-config.json"
        assert "main/logic.js" in names, f"{z}: 缺 main/logic.js"
print("OK")
EOF
[ $? -eq 0 ] && ok "12 个 zip:bundle.json@根 + main/app-config.json + main/logic.js 齐" || bad "发布产物完备性"

echo "== 1. 逐包 install + 市场列表断言 =="
for row in "${PKGS[@]}"; do
  read -r zip appid code entry backend <<<"$row"
  if run_cli bundle install "$DIST/$zip"; then ok "install $zip"; else bad "install $zip"; cli_show; continue; fi
  apps_json | python3 -c "
import json,sys
apps=json.load(sys.stdin)['apps']
a=next((x for x in apps if x['appId']=='$appid'),None)
assert a, '$appid 不在列表'
assert a['versionCode']==$code, f\"versionCode {a['versionCode']} != $code\"
assert str(a.get('backend')).lower()=='$backend', f\"backend {a.get('backend')} != ${backend}\"
assert a['path']=='$entry', f\"path {a['path']} != $entry\"
" && ok "$appid 字段正确(code=$code backend=$backend path=$entry)" || bad "$appid 字段断言"
done
n=$(apps_json | python3 -c "import json,sys; print(len(json.load(sys.stdin)['apps']))")
[ "$n" -eq 12 ] && ok "/api/v1/apps 共 12 行" || bad "/api/v1/apps 行数 $n != 12"

echo "== 2. manifest / sha256 / 包下载链路 =="
for row in "${PKGS[@]}"; do
  read -r zip appid code _entry _backend <<<"$row"
  murl="$(printf "$MANIFEST_T" "$appid")"
  curl -sf "$murl" | python3 -c "import json,sys; json.load(sys.stdin)" && ok "manifest 200 合法 $appid" || bad "manifest $appid"
  apps_json | python3 -c "
import json,sys
a=next(x for x in json.load(sys.stdin)['apps'] if x['appId']=='$appid')
assert a.get('sha256'), 'sha256 空'
assert len(a['sha256'])==64, 'sha256 长度异常'" && ok "sha256 合法 $appid" || bad "sha256 $appid"
  curl -sfI "$PKG_BASE/$zip" | head -1 | grep -q " 200" && ok "包下载 200 $zip" || bad "包下载 $zip"
done

echo "== 3. routes 表干净 =="
routes=$(curl -sf "$SERVER$ROUTES_API") && ok "routes 端点可达($ROUTES_API)" || bad "routes 端点不可达(export ROUTES_API=… 后重跑)"
echo "$routes" | python3 -c "
import json,sys
r=json.load(sys.stdin)
rows=r.get('routes',r) if isinstance(r,dict) else r
assert len(rows)==1, f'期望仅 1 条路由,得 {len(rows)}: {rows}'
row=rows[0]
prefix=str(row.get('prefix') or row.get('path') or row.get('route'))
assert prefix=='/', f'前缀 {prefix} != /'
app=str(row.get('appId') or row.get('app') or '')
assert app=='$SYSMON', f'归属 app {app} != sys-monitor'
" && ok "routes 仅 sys-monitor 一条 /(v1 target 占位)" || bad "routes 断言"
for dirty in wx3d8b6f2a9c4e7d15 wx92269e3b2f304afc wx3a7f2c9e1b8d4f56 wx9d4e6a2c8b1f7e35; do
  echo "$routes" | grep -q "$dirty" && bad "脏路由残留 $dirty" || ok "无脏路由 $dirty"
done

echo "== 4. 生命周期抽查(flappy:upgrade→rollback→remove→install)=="
python3 - "$DIST/$FLAPPY-10.zip" "$TMP/$FLAPPY-11.zip" <<'EOF'
import json, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z, zipfile.ZipFile(dst,"w",zipfile.ZIP_DEFLATED) as out:
    for n in z.namelist():
        data=z.read(n)
        if n=="bundle.json":
            b=json.loads(data); b["version"]={"code":11,"name":"1.1.7"}
            data=json.dumps(b,ensure_ascii=False,indent=2).encode()
        out.writestr(n,data)
EOF
run_cli bundle upgrade "$TMP/$FLAPPY-11.zip" && ok "upgrade code+1" || { bad "upgrade"; cli_show; }
apps_json | python3 -c "
import json,sys
a=next(x for x in json.load(sys.stdin)['apps'] if x['appId']=='$FLAPPY')
assert a['versionCode']==11, a['versionCode']" && ok "升级后 versionCode=11" || bad "升级后版本"
run_cli bundle rollback --app "$FLAPPY" && ok "rollback" || { bad "rollback"; cli_show; }
apps_json | python3 -c "
import json,sys
a=next(x for x in json.load(sys.stdin)['apps'] if x['appId']=='$FLAPPY')
assert a['versionCode']==10, a['versionCode']" && ok "回滚后 versionCode=10" || bad "回滚后版本"
run_cli bundle remove --app "$FLAPPY" && ok "remove" || { bad "remove"; cli_show; }
apps_json | python3 -c "
import json,sys
apps=json.load(sys.stdin)['apps']
assert not any(x['appId']=='$FLAPPY' for x in apps), 'remove 后市场行仍在'" && ok "remove 后市场行已清" || bad "remove 后市场行"
curl -sf "$SERVER$ROUTES_API" | grep -q "$FLAPPY" && bad "remove 后路由残留" || ok "remove 后路由已撤"
run_cli bundle install "$DIST/$FLAPPY-10.zip" && ok "remove→install 同版本重装" || { bad "同版本重装"; cli_show; }
apps_json | python3 -c "
import json,sys
a=next(x for x in json.load(sys.stdin)['apps'] if x['appId']=='$FLAPPY')
assert a['versionCode']==10, a['versionCode']" && ok "重装后 versionCode=10(保持)" || bad "重装后版本"

echo "== 5. 失败面抽查 =="
python3 - "$DIST/$FLAPPY-10.zip" "$TMP" "$FLAPPY" <<'EOF'
import json, sys, zipfile
src, tmp, real_appid = sys.argv[1], sys.argv[2], sys.argv[3]
def repack(dst, mut):
    with zipfile.ZipFile(src) as z, zipfile.ZipFile(dst,"w",zipfile.ZIP_DEFLATED) as out:
        for n in z.namelist():
            if mut=="drop" and n=="bundle.json": continue
            data=z.read(n)
            if n=="bundle.json":
                b=json.loads(data)
                if mut=="appid": b["appId"]="wx0000000000000000"
                if mut=="rollback": b["version"]={"code":9,"name":"1.1.5"}
                data=json.dumps(b,ensure_ascii=False,indent=2).encode()
            out.writestr(n,data)
        if mut=="appid":  # 门禁依据:包内 project.config.json 的 appid 与 bundle.json 不一致
            pc=json.dumps({"appid":real_appid,"projectname":"flappy-bird"},ensure_ascii=False).encode()
            out.writestr("project.config.json",pc)
            out.writestr("main/project.config.json",pc)
repack(f"{tmp}/no-manifest.zip","drop")
repack(f"{tmp}/bad-appid.zip","appid")
repack(f"{tmp}/rollback.zip","rollback")
EOF
run_cli bundle install "$TMP/no-manifest.zip" && bad "缺 bundle.json 竟被接受" || ok "缺 bundle.json 拒收"
run_cli bundle install "$TMP/bad-appid.zip" && bad "appId 不一致竟被接受" || ok "appId 不一致拒收"
run_cli bundle upgrade "$TMP/rollback.zip" && bad "versionCode 倒退竟被接受" || ok "versionCode 倒退拒收"
apps_json | python3 -c "
import json,sys
a=next(x for x in json.load(sys.stdin)['apps'] if x['appId']=='$FLAPPY')
assert a['versionCode']==10, a['versionCode']" && ok "拒收后现场未被破坏(flappy 仍 v10)" || bad "拒收后现场"

echo
echo "== 结果:PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] || exit 1
