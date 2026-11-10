#!/usr/bin/env bash
# star-drift（星际穿行）构建脚本（shell-dev 维护）
#
# 用法：./build.sh
#   ① esbuild 全链路 ESM 打包 src/main.js → js/bundle.js（--bundle --minify --format=cjs；
#      Dimina 逻辑层 QuickJS 要求 CJS：game.js 里 require('./js/bundle.js')）
#   ② 双实例校验：bundle 里 'Multiple instances'（three 被打包两份的告警串，
#      three.module.js 本体恰含 1 处）必须 ≤1，否则报错退出
#   ③ 同步/dmcc 编译/assets+icon/zip/publish 属发布链，由 lead 执行——
#      逐条可独立执行的参考段在文末注释里
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

THREE_BENCH="/Users/weimingchen/Documents/deepseek-harness/default-workspace/three-bench-build"
ESBUILD="${ESBUILD_BIN:-$THREE_BENCH/node_modules/.bin/esbuild}"

# esbuild 二进制：配方沿用 road-hop/three-bench 的；缺失时回退本地 node_modules
if [ ! -x "$ESBUILD" ] && [ -x "$ROOT/node_modules/.bin/esbuild" ]; then
  ESBUILD="$ROOT/node_modules/.bin/esbuild"
fi
[ -x "$ESBUILD" ] || { echo "[build] 找不到可执行的 esbuild: $ESBUILD"; exit 2; }

# three 依赖解析：symlink three-bench 的 node_modules 进本项目（不复制包）。
# 用绝对路径做 target，源码同步到 ~/Code/dsh-go-miniprograms/star-drift/ 后仍可解析。
if [ ! -e "$ROOT/node_modules" ]; then
  [ -d "$THREE_BENCH/node_modules" ] || { echo "[build] 缺 $THREE_BENCH/node_modules"; exit 2; }
  ln -s "$THREE_BENCH/node_modules" "$ROOT/node_modules"
  echo "[build] node_modules -> $THREE_BENCH/node_modules (symlink)"
fi

# 队友文件预检：engine.js/renderer.js 并行开发中，缺失属正常——报告归属后退出（不产 bundle）
MISSING=0
for f in src/main.js src/store.js src/engine.js src/renderer.js; do
  [ -f "$f" ] || { echo "[build] 缺 $f（engine.js 归 engine-dev / renderer.js 归 render-dev，落地后再跑）"; MISSING=1; }
done
[ "$MISSING" -eq 0 ] || exit 3

mkdir -p js

echo "[build] esbuild bundling src/main.js -> js/bundle.js"
"$ESBUILD" src/main.js --bundle --minify --format=cjs --outfile=js/bundle.js --log-level=warning

[ -s js/bundle.js ] || { echo "[build] js/bundle.js 为空，打包失败"; exit 4; }

# ---- 双实例校验 ----
# 单份 three → bundle 里 'Multiple instances' 恰 1 处（three 自带告警串随包保留）；
# 出现 ≥2 = ESM/CJS 混用导致 three 双实例，QuickJS 下会行为异常，禁止发。
LINES="$(grep -c 'Multiple instances' js/bundle.js || true)"; LINES="${LINES:-0}"
OCCUR="$( { grep -o 'Multiple instances' js/bundle.js || true; } | wc -l | tr -d ' ' )"; OCCUR="${OCCUR:-0}"
if [ "$LINES" -gt 1 ] || [ "$OCCUR" -gt 1 ]; then
  echo "[build] FAIL: three 双实例告警 'Multiple instances' 行数=$LINES 次数=$OCCUR（要求 ≤1）"
  exit 5
fi

echo "[build] OK: js/bundle.js $(wc -c < js/bundle.js | tr -d ' ') bytes, 'Multiple instances' ×$OCCUR (≤1)"
echo "[build] 下一步见文末注释段（同步/dmcc/zip/publish 由 lead 执行）"

# ============================================================================
# 发布参考段（lead 专用，未启用；每条可独立复制执行）
# 前提：./build.sh 已通过（js/bundle.js 就位 + 双实例校验通过）。
# ----------------------------------------------------------------------------
# 1) 同步源码到正式仓（工作区 → ~/Code/dsh-go-miniprograms/star-drift/）：
#      rsync -a --delete \
#        --exclude node_modules --exclude .DS_Store --exclude '*.log' \
#        ~/Documents/deepseek-harness/default-workspace/star-drift-build/ \
#        ~/Code/dsh-go-miniprograms/star-drift/
#    说明：node_modules 是 symlink 不带走；正式仓若要重跑 build.sh，
#      ln -s /Users/weimingchen/Documents/deepseek-harness/default-workspace/three-bench-build/node_modules node_modules
#
# 2) dmcc 编译（node>=22，dimina fe 依赖已 pnpm install 过）：
#      cd ~/Code/dimina/fe
#      node packages/compiler/src/bin/index.js build \
#        -c ~/Code/dsh-go-miniprograms/star-drift -s /tmp/star-drift-dist
#    产物：/tmp/star-drift-dist/wx8c4e2f6a9d1b7e53/main/
#    注意 assets/（glTF + bin + 贴图）由 dmcc 收编进 main/，zip 前确认 main/assets/ 在列
#
# 3) icon + zip（zip 根必须 main/；icon.png 必须 512×512 且进 main/，publish 自动抽为市场图标）：
#      cp ~/Code/dsh-go-miniprograms/star-drift/icon.png \
#         /tmp/star-drift-dist/wx8c4e2f6a9d1b7e53/main/icon.png
#      cd /tmp/star-drift-dist/wx8c4e2f6a9d1b7e53
#      zip -qr /tmp/star-drift-<版本>.zip main
#      unzip -l /tmp/star-drift-<版本>.zip   # 校验：第一层是 main/，含 main/icon.png 与 main/assets/
#
# 4) 发布上架（--version-code 必须严格递增，否则手机端永不升级；game 类型 --path 固定填 game）：
#      cd ~/Code/dsh-Go-apphub/apphub && ~/dev/flutter/bin/dart pub get
#      ~/dev/flutter/bin/dart run bin/apphubctl.dart publish /tmp/star-drift-<版本>.zip \
#        --app wx8c4e2f6a9d1b7e53 --name 星际穿行 --path game \
#        --version-code <N> --version-name <X.Y.Z> \
#        --key "$(python3 -c "import json;print(json.load(open('$HOME/dsh/apphub/config.json'))['publisherKey'])")"
#    验证上架：curl -s http://127.0.0.1:7610/api/v1/apps | python3 -m json.tool | grep -A3 wx8c4e2f6a9d1b7e53
#    回滚：    ~/dev/flutter/bin/dart run bin/apphubctl.dart rollback --app wx8c4e2f6a9d1b7e53
# ============================================================================
