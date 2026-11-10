#!/usr/bin/env bash
# 万器 Bundle 端到端迁移验证清单(task-3)。
# 对测试 server 逐包 install 12 个示例 zip,断言:市场列表/manifest/sha256/包下载/
# routes 干净/flappy 生命周期(upgrade→rollback→remove→install)/失败面三条拒收。
#
# 用法(仓库根执行):
#   bash scripts/verify-migration.sh
# 可覆盖变量:
#   SERVER      测试 server 基址        (默认 http://127.0.0.1:7620)
#   WANQI       CLI 命令(不含参数)    (默认 "dart run bin/wanqi.dart",在 server/ 内执行)
#   ROUTES_API  routes 表端点           (默认 /api/v1/routes)
#   PKG_BASE    包下载前缀              (默认 $SERVER/packages)
#   MANIFEST_T  manifest 端点模板       (默认 $SERVER/apps/%s/manifest.json)
set -u
cd "$(dirname "$0")/.." || exit 2
ROOT="$(pwd)"
SERVER="${SERVER:-http://127.0.0.1:7620}"
WANQI="${WANQI:-dart run bin/wanqi.dart}"
ROUTES_API="${ROUTES_API:-/api/v1/routes}"
PKG_BASE="${PKG_BASE:-$SERVER/packages}"
MANIFEST_T="${MANIFEST_T:-$SERVER/apps/%s/manifest.json}"
DIST="$ROOT/examples/dist"
TMP="$(mktemp -d /tmp/wanqi-verify.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $*"; }
run_cli() { (cd "$ROOT/server" && $WANQI "$@") ; }

# ---- 12 包清单:zip 文件名 appId code name entry backend(true/false)----
PKGS=(
  "wx5b8e2f4a9c1d7e60-10.zip wx5b8e2f4a9c1d7e60 10 Flappy_Bird game false"
  "wx2f8a4c6e1d3b5a79-14.zip wx2f8a4c6e1d3b5a79 14 GLM app false"
  "wx3d7b2f91c4a8e5d6-13.zip wx3d7b2f91c4a8e5d6 13 three-bench game false"
  "wx9d4e6a2c8b1f7e35-4.zip  wx9d4e6a2c8b1f7e35 4  webbench pages/index/index false"
  "wx92269e3b2f304afc-73.zip wx92269e3b2f304afc 73 weui example/index false"
  "wx3d8b6f2a9c4e7d15-20.zip wx3d8b6f2a9c4e7d15 20 shuangpin pages/home/home false"
  "wx8c4e2f6a9d1b7e53-10.zip wx8c4e2f6a9d1b7e53 10 star-drift game false"
  "darkmode-demo-3.zip       darkmode-demo      3  darkmode pages/index/index false"
  "wx8d31a5f0c94b27e6-8.zip  wx8d31a5f0c94b27e6 8  sys-monitor pages/index/index true"
  "wx7c3e9d2a1b4f5e68-4.zip  wx7c3e9d2a1b4f5e68 4  ledger pages/list/list false"
  "wx5f8a2d7c9e1b4f30-2.zip  wx5f8a2d7c9e1b4f30 2  road-hop game false"
  "wx3a7f2c9e1b8d4f56-1.zip  wx3a7f2c9e1b8d4f56 1  audio pages/audio/audio false"
)
FLAPPY=wx5b8e2f4a9c1d7e60

echo "== 0. 前置:server 可达 =="
curl -sf "$SERVER/api/v1/apps" >/dev/null && ok "server 可达 $SERVER" || { bad "server 不可达 $SERVER,先启动测试 server"; exit 1; }

echo "== 1. 逐包 install + 市场列表断言 =="
for row in "${PKGS[@]}"; do
  read -r zip appid code _name entry backend <<<"$row"
  if run_cli bundle install "$DIST/$zip" >/dev/null 2>&1; then ok "install $zip"; else bad "install $zip"; continue; fi
  want="\"versionCode\":$code"
  curl -sf "$SERVER/api/v1/apps" | grep -q "$appid" && ok "市场列表含 $appid" || bad "市场列表缺 $appid"
  curl -sf "$SERVER/api/v1/apps" | python3 -c "
import json,sys
apps=json.load(sys.stdin)['apps']
a=next((x for x in apps if x['appId']=='$appid'),None)
assert a, '$appid 不在列表'
assert a['versionCode']==$code, f\"versionCode {a['versionCode']} != $code\"
assert a.get('backend') is ${backend}, f\"backend {a.get('backend')} != ${backend}\"
assert a['path']=='$entry', f\"path {a['path']} != $entry\"
" && ok "$appid 字段正确(code=$code backend=$backend path=$entry)" || bad "$appid 字段断言"
done

echo "== 2. manifest / sha256 / 包下载链路 =="
for row in "${PKGS[@]}"; do
  read -r zip appid code _name _entry _backend <<<"$row"
  murl="$(printf "$MANIFEST_T" "$appid")"
  curl -sf "$murl" | python3 -c "import json,sys; json.load(sys.stdin)" && ok "manifest 200 合法 $appid" || bad "manifest $appid"
  s=$(curl -sf "$SERVER/api/v1/apps" | python3 -c "
import json,sys
a=next(x for x in json.load(sys.stdin)['apps'] if x['appId']=='$appid')
print(a['sha256'])") && [ -n "$s" ] && ok "sha256 非空 $appid" || bad "sha256 $appid"
  curl -sfI "$PKG_BASE/$zip" | head -1 | grep -q " 200" && ok "包下载 200 $zip" || bad "包下载 $zip"
done

echo "== 3. routes 表干净 =="
routes=$(curl -sf "$SERVER$ROUTES_API") && ok "routes 端点可达" || bad "routes 端点不可达(export ROUTES_API=… 后重跑)"
echo "$routes" | python3 -c "
import json,sys
r=json.load(sys.stdin)
# 兼容 {routes:[…]} 或 […] 两种形态
rows=r.get('routes',r) if isinstance(r,dict) else r
assert len(rows)==1, f'期望仅 1 条路由,得 {len(rows)}: {rows}'
row=rows[0]
prefix=str(row.get('prefix') or row.get('path') or row.get('route'))
assert prefix=='/', f'前缀 {prefix} != /'
app=str(row.get('appId') or row.get('app') or '')
assert app=='wx8d31a5f0c94b27e6', f'归属 app {app} != sys-monitor'
" && ok "routes 仅 sys-monitor 一条 / → 动态 target" || bad "routes 断言"
for dirty in wx3d8b6f2a9c4e7d15 wx92269e3b2f304afc wx3a7f2c9e1b8d4f56 wx9d4e6a2c8b1f7e35; do
  echo "$routes" | grep -q "$dirty" && bad "脏路由残留 $dirty" || ok "无脏路由 $dirty"
done

echo "== 4. 生命周期抽查(flappy:upgrade→rollback→remove→install)=="
python3 - "$DIST/$FLAPPY-10.zip" "$TMP/$FLAPPY-11.zip" <<'EOF'
import json, shutil, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z, zipfile.ZipFile(dst,"w",zipfile.ZIP_DEFLATED) as out:
    for n in z.namelist():
        data=z.read(n)
        if n=="bundle.json":
            b=json.loads(data); b["version"]={"code":11,"name":"1.1.7"}; data=json.dumps(b,ensure_ascii=False,indent=2).encode()
        out.writestr(n,data)
EOF
run_cli bundle upgrade "$TMP/$FLAPPY-11.zip" >/dev/null 2>&1 && ok "upgrade code+1" || bad "upgrade"
curl -sf "$SERVER/api/v1/apps" | python3 -c "
import json,sys
a=next(x for x in json.load(sys.stdin)['apps'] if x['appId']=='$FLAPPY')
assert a['versionCode']==11, a['versionCode']" && ok "升级后 versionCode=11" || bad "升级后版本"
run_cli bundle rollback "$FLAPPY" >/dev/null 2>&1 && ok "rollback" || bad "rollback"
curl -sf "$SERVER/api/v1/apps" | python3 -c "
import json,sys
a=next(x for x in json.load(sys.stdin)['apps'] if x['appId']=='$FLAPPY')
assert a['versionCode']==10, a['versionCode']" && ok "回滚后 versionCode=10" || bad "回滚后版本"
run_cli bundle remove "$FLAPPY" >/dev/null 2>&1 && ok "remove" || bad "remove"
curl -sf "$SERVER$ROUTES_API" | grep -q "$FLAPPY" && bad "remove 后路由残留" || ok "remove 后路由已撤"
run_cli bundle install "$DIST/$FLAPPY-10.zip" >/dev/null 2>&1 && ok "remove→install 同版本重装" || bad "同版本重装"
curl -sf "$SERVER/api/v1/apps" | python3 -c "
import json,sys
a=next(x for x in json.load(sys.stdin)['apps'] if x['appId']=='$FLAPPY')
assert a['versionCode']==10" && ok "重装后 versionCode=10(保持)" || bad "重装后版本"

echo "== 5. 失败面抽查 =="
python3 - "$DIST/$FLAPPY-10.zip" "$TMP" <<'EOF'
import json, sys, zipfile
src, tmp = sys.argv[1], sys.argv[2]
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
repack(f"{tmp}/no-manifest.zip","drop")
repack(f"{tmp}/bad-appid.zip","appid")
repack(f"{tmp}/rollback.zip","rollback")
EOF
run_cli bundle install "$TMP/no-manifest.zip" >/dev/null 2>&1 && bad "缺 bundle.json 竟被接受" || ok "缺 bundle.json 拒收"
run_cli bundle install "$TMP/bad-appid.zip" >/dev/null 2>&1 && bad "appId 不一致竟被接受" || ok "appId 不一致拒收"
run_cli bundle upgrade "$TMP/rollback.zip" >/dev/null 2>&1 && bad "versionCode 倒退竟被接受" || ok "versionCode 倒退拒收"

echo
echo "== 结果:PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] || exit 1
